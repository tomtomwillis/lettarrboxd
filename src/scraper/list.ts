import * as cheerio from 'cheerio';
import { fetchPage } from './fetch';
import Bluebird from 'bluebird';
import { LetterboxdMovie, LETTERBOXD_BASE_URL } from ".";
import { getMovie } from './movie';
import logger from '../util/logger';
import Scraper from './scraper.interface';

export interface ListScrapeResult {
    movies: LetterboxdMovie[];
    /** Number of film links found on the list pages (after `take` is applied). */
    linkCount: number;
    /** Links whose film page could not be scraped. */
    failedLinks: string[];
}

export class ListScraper implements Scraper {
    constructor(private url: string, private take?: number, private strategy?: 'oldest' | 'newest') {}

    async getMovies(): Promise<LetterboxdMovie[]> {
        const { movies } = await this.getMoviesWithStatus();
        return movies;
    }

    /**
     * Like getMovies, but also reports how many films were on the list and which
     * ones failed to scrape, so callers can tell a complete snapshot of the list
     * from a partial one.
     */
    async getMoviesWithStatus(): Promise<ListScrapeResult> {
        let processUrl = this.url;
        
        if (this.strategy === 'oldest') {
            processUrl = this.url.replace(/\/$/, '') + '/by/date-earliest/';
        }
        
        const allMovieLinks = await this.getAllMovieLinks(processUrl);
        const linksToProcess = typeof this.take === 'number' ? allMovieLinks.slice(0, this.take) : allMovieLinks;

        const failedLinks: string[] = [];
        const results = await Bluebird.map(linksToProcess, async link => {
            try {
                return await getMovie(link);
            } catch (error) {
                logger.error({ err: error }, `Failed to scrape movie ${link}, skipping.`);
                failedLinks.push(link);
                return null;
            }
        }, {
            concurrency: 10
        });

        return {
            movies: results.filter((movie): movie is LetterboxdMovie => movie !== null),
            linkCount: linksToProcess.length,
            failedLinks
        };
    }

    private async getAllMovieLinks(baseUrl: string): Promise<string[]> {
        let currentUrl: string | null = baseUrl;
        const allLinks: string[] = [];
        
        while (currentUrl) {
            logger.debug(`Fetching page: ${currentUrl}`);
            
            const response = await fetchPage(currentUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch list page: ${response.status}`);
            }
            
            const html = await response.text();
            const pageLinks = this.getMovieLinksFromHtml(html);
            allLinks.push(...pageLinks);
            
            currentUrl = this.getNextPageUrl(html);
            
            if (currentUrl) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        logger.debug(`Retrieved ${allLinks.length} links from letterboxd list.`);

        return allLinks;
    }

    private getMovieLinksFromHtml(html: string): string[] {
        const $ = cheerio.load(html);
        const links: string[] = [];
        
        $('.react-component[data-target-link]').each((_, element) => {
            const filmLink = $(element).attr('data-target-link');
            if (filmLink) {
                links.push(filmLink);
            }
        });
        logger.debug(`Found ${links.length} links.`);
        return links;
    }

    private getNextPageUrl(html: string): string | null {
        const $ = cheerio.load(html);
        const nextLink = $('.paginate-nextprev .next').attr('href');
        
        if (nextLink) {
            return new URL(nextLink, LETTERBOXD_BASE_URL).toString();
        }
        
        return null;
    }
}