import Axios from 'axios';
import env from '../util/env';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';
import Bluebird from 'bluebird';

interface RadarrMovie {
    title: string;
    qualityProfileId: number;
    rootFolderPath: string;
    tmdbId: number;
    minimumAvailability: string;
    monitored: boolean;
    tags: number[];
    addOptions: {
        searchForMovie: boolean;
    }
}

const DEFAULT_TAG_NAME = 'letterboxd';

const axios = Axios.create({
    baseURL: env.RADARR_API_URL,
    headers: {
        'X-Api-Key': env.RADARR_API_KEY
    }
});

// Summarize an error for logging. Axios errors are reduced to the request and
// response details; the raw error would include request headers (the API key).
export function describeError(error: unknown): Record<string, unknown> {
    if (Axios.isAxiosError(error)) {
        return {
            message: error.message,
            code: error.code,
            method: error.config?.method?.toUpperCase(),
            url: error.config ? axios.getUri(error.config) : undefined,
            status: error.response?.status,
            data: error.response?.data
        };
    }
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
}

export async function getQualityProfileId(profileName: string): Promise<number | null> {
    try {
        logger.debug(`Getting quality profile ID for: ${profileName}`);

        const response = await axios.get('/api/v3/qualityprofile');
        const profiles = response.data;

        const profile = profiles.find((p: any) => p.name === profileName);
        if (profile) {
            logger.debug(`Found quality profile: ${profileName} (ID: ${profile.id})`);
            return profile.id;
        } else {
            const available = profiles.map((p: any) => p.name);
            logger.error({ available }, `Quality profile not found: ${profileName}`);
            return null;
        }
    } catch (error) {
        logger.error({ error: describeError(error) }, 'Error getting quality profiles from Radarr');
        return null;
    }
}

export async function getRootFolder(): Promise<string | null> {
    try {
        const response = await axios.get('/api/v3/rootfolder');
        const rootFolders = response.data;

        if (rootFolders.length > 0) {
            const rootFolder = rootFolders[0].path;
            logger.debug(`Using root folder: ${rootFolder}`);
            return rootFolder;
        } else {
            logger.error('No root folders found in Radarr');
            return null;
        }
    } catch (error) {
        logger.error({ error: describeError(error) }, 'Error getting root folders from Radarr');
        return null;
    }
}

export async function getRootFolderById(id: string) {
    try {
        const response = await axios.get(`/api/v3/rootfolder/${id}`);
        const { data } = response;
        if (data) {
            return data.path;
        } else {
            return null;
        }
    } catch (e) {
        logger.error({ error: describeError(e) }, `Error getting root folder by id: ${id}`);
        return null;
    }
}

export async function getOrCreateTag(tagName: string): Promise<number | null> {
    try {
        logger.debug(`Getting or creating tag: ${tagName}`);

        const response = await axios.get('/api/v3/tag');
        const tags = response.data;

        const existingTag = tags.find((tag: any) => tag.label === tagName);
        if (existingTag) {
            logger.debug(`Tag already exists: ${tagName} (ID: ${existingTag.id})`);
            return existingTag.id;
        }

        logger.debug(`Creating new tag: ${tagName}`);
        const createResponse = await axios.post('/api/v3/tag', {
            label: tagName
        });

        logger.info(`Created tag: ${tagName} (ID: ${createResponse.data.id})`);
        return createResponse.data.id;
    } catch (error) {
        logger.error({ error: describeError(error) }, `Error getting or creating tag ${tagName}`);
        return null;
    }
}

function parseConfiguredTags(): string[] {
    const tags = [DEFAULT_TAG_NAME];

    if (env.RADARR_TAGS) {
        const userTags = env.RADARR_TAGS
            .split(',')
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);
        tags.push(...userTags);
    }

    return [...new Set(tags)];
}

export async function getAllRequiredTagIds(): Promise<number[]> {
    const tagNames = parseConfiguredTags();
    const tagIdPromises = tagNames.map(tagName => getOrCreateTag(tagName));
    const tagIdsRaw = await Promise.all(tagIdPromises);
    const tagIds = tagIdsRaw.filter((tagId): tagId is number => tagId !== null);

    // Log warnings for any failed tag creations
    tagNames.forEach((tagName, index) => {
        if (tagIdsRaw[index] === null) {
            logger.warn(`Failed to create or retrieve tag: ${tagName}`);
        }
    });

    return tagIds;
}

export async function upsertMovies(movies: LetterboxdMovie[]): Promise<void> {
    const qualityProfileId = await getQualityProfileId(env.RADARR_QUALITY_PROFILE);

    if (!qualityProfileId) {
        throw new Error('Could not get quality profile ID.');
    }

    const rootFolderPath = !env.RADARR_ROOT_FOLDER_ID ? await getRootFolder() : await getRootFolderById(env.RADARR_ROOT_FOLDER_ID);

    if (!rootFolderPath) {
        throw new Error('Could not get root folder');
    }

    const tagIds = await getAllRequiredTagIds();

    await Bluebird.map(movies, movie => {
        return addMovie(movie, qualityProfileId, rootFolderPath, tagIds, env.RADARR_MINIMUM_AVAILABILITY);
    });
}

interface RadarrLibraryMovie {
    id: number;
    title: string;
    tmdbId: number;
    monitored: boolean;
    hasFile: boolean;
    tags: number[];
}

export type RemoveMode = 'unmonitor' | 'delete';

/**
 * Remove (or unmonitor) Radarr movies that this instance added but that are no
 * longer on the Letterboxd list, e.g. because they were logged as watched.
 *
 * Only movies that carry every one of this instance's tags and have no file on
 * disk are affected. Files are never deleted.
 *
 * `listMovies` must be a complete snapshot of the list; the caller is
 * responsible for checking that.
 */
export async function removeMissingMovies(listMovies: LetterboxdMovie[], mode: RemoveMode): Promise<void> {
    const tagNames = parseConfiguredTags();
    const tagIds = await getAllRequiredTagIds();
    if (tagIds.length !== tagNames.length) {
        // Without every tag we cannot reliably tell which movies this instance owns.
        throw new Error('Could not resolve all configured tags; skipping removal.');
    }

    const onList = new Set(
        listMovies
            .map(movie => movie.tmdbId ? parseInt(movie.tmdbId, 10) : NaN)
            .filter(id => !Number.isNaN(id))
    );

    const response = await axios.get('/api/v3/movie');
    const library: RadarrLibraryMovie[] = response.data;

    const ours = library.filter(movie => tagIds.every(tagId => movie.tags?.includes(tagId)));
    const gone = ours.filter(movie => !onList.has(movie.tmdbId));

    const downloaded = gone.filter(movie => movie.hasFile);
    for (const movie of downloaded) {
        logger.debug(`${movie.title} is no longer on the list but is already downloaded; keeping it.`);
    }

    const toRemove = gone.filter(movie => !movie.hasFile && (mode === 'delete' || movie.monitored));
    if (toRemove.length === 0) {
        logger.debug('No movies to remove from Radarr.');
        return;
    }

    const verb = mode === 'delete' ? 'Removing' : 'Unmonitoring';
    for (const movie of toRemove) {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would ${mode} movie no longer on list: ${movie.title} (TMDB: ${movie.tmdbId})`);
            continue;
        }

        try {
            if (mode === 'delete') {
                await axios.delete(`/api/v3/movie/${movie.id}`, {
                    params: { deleteFiles: false, addImportExclusion: false }
                });
            } else {
                await axios.put('/api/v3/movie/editor', { movieIds: [movie.id], monitored: false });
            }
            logger.info(`${verb} movie no longer on list: ${movie.title} (TMDB: ${movie.tmdbId})`);
        } catch (error) {
            logger.error({ error: describeError(error) }, `Error trying to ${mode} movie ${movie.title} (TMDB: ${movie.tmdbId})`);
        }
    }
}

export async function addMovie(movie: LetterboxdMovie, qualityProfileId: number, rootFolderPath: string, tagIds: number[], minimumAvailability: string): Promise<void> {
    try {
        logger.debug(`Adding movie to Radarr: ${movie.name}`);

        if (!movie.tmdbId) {
            logger.info(`Could not add movie ${movie.name} because no tmdb id was found. Is this a TV show?`);
            return;
        }

        const payload: RadarrMovie = {
            title: movie.name,
            qualityProfileId,
            rootFolderPath,
            tmdbId: parseInt(movie.tmdbId),
            minimumAvailability,
            monitored: !env.RADARR_ADD_UNMONITORED,
            tags: tagIds,
            addOptions: {
                searchForMovie: true
            }
        }

        if (env.DRY_RUN) {
            logger.info({ payload }, `[DRY RUN] Would add movie to Radarr: ${payload.title} (TMDB: ${payload.tmdbId})`);
            return;
        }

        const response = await axios.post('/api/v3/movie', payload);

        logger.info(`Successfully added movie: ${payload.title}`);
        logger.debug({ movie: response.data }, `Radarr response for ${payload.title}`);
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 400 && (JSON.stringify(e.response?.data)).includes('This movie has already been added')) {
            logger.debug(`Movie ${movie.name} already exists in Radarr, skipping`);
            return;
        }
        logger.error({ error: describeError(e) }, `Error adding movie ${movie.name} (TMDB: ${movie.tmdbId})`);
    }
}
