require('dotenv').config();


import env from './util/env';
import logger from './util/logger';
import { scrapeUrl, ScrapeResult } from './scraper';
import { upsertMovies, removeMissingMovies } from './api/radarr';

function startScheduledMonitoring(): void {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;

  logger.info(`Starting scheduled monitoring. Will check every ${env.CHECK_INTERVAL_MINUTES} minutes.`);

  // Run immediately on startup
  run();

  // Then run on interval
  setInterval(async () => {
    await run();
  }, intervalMs);
}

async function run() {
  try {
    const result = await scrapeUrl(env.LETTERBOXD_URL);
    await upsertMovies(result.movies);
    await removeMoviesNoLongerOnList(result);
  } catch (error) {
    // Log and keep the scheduler alive; the next interval will retry.
    logger.error({ err: error }, 'Sync run failed');
  }
}

async function removeMoviesNoLongerOnList(result: ScrapeResult): Promise<void> {
  const mode = env.RADARR_REMOVE_MISSING;
  if (mode !== 'unmonitor' && mode !== 'delete') {
    return;
  }

  if (!result.complete) {
    logger.warn(`Skipping removal: the ${result.listType} scrape was incomplete or this list type does not support removal.`);
    return;
  }

  if (result.movies.length === 0) {
    // An empty result is far more likely to be a blocked/changed page than a
    // genuinely empty list; never treat it as "remove everything".
    logger.warn('Skipping removal: the list came back empty.');
    return;
  }

  await removeMissingMovies(result.movies, mode);
}

export async function main() {
  startScheduledMonitoring();
}

export { startScheduledMonitoring };

// Only run main if this file is executed directly
if (require.main === module) {
  logger.info(`Lettarrboxd version ${process.env.APP_VERSION || 'dev'}`);
  main().catch(err => logger.error({ err }, 'Fatal error'));
}