import { main, startScheduledMonitoring } from './index';
import * as scraperModule from './scraper';
import * as radarrModule from './api/radarr';
import logger from './util/logger';
import env from './util/env';

// Mock dependencies
jest.mock('./util/env', () => ({
  CHECK_INTERVAL_MINUTES: 10,
  LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
  RADARR_REMOVE_MISSING: 'off',
}));
jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scraper');
jest.mock('./api/radarr');

describe('main application', () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setIntervalSpy = jest.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setIntervalSpy.mockRestore();
  });

  describe('startScheduledMonitoring', () => {
    it('should run immediately and schedule interval', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: mockMovies, listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete without advancing timers
      await Promise.resolve();

      expect(scraperModule.scrapeUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.upsertMovies).toHaveBeenCalledTimes(1);

      // Verify setInterval was called with correct interval (10 minutes = 600000ms)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 600000);
    });

    it('should fetch movies and upsert them during run', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Movie 1',
          slug: '/film/movie1/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
        {
          id: 2,
          name: 'Movie 2',
          slug: '/film/movie2/',
          tmdbId: '456',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: mockMovies, listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete
      await Promise.resolve();

      expect(scraperModule.scrapeUrl).toHaveBeenCalledWith(
        'https://letterboxd.com/user/watchlist'
      );
      expect(radarrModule.upsertMovies).toHaveBeenCalledWith(mockMovies);
    });

    it('should call scrapeUrl and upsertMovies on interval', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: mockMovies, listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for immediate run
      await Promise.resolve();

      // Clear mocks to test interval callback
      jest.clearAllMocks();
      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: mockMovies, listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      // Fast-forward time by 10 minutes and run the interval callback
      jest.advanceTimersByTime(600000);
      await Promise.resolve();

      // Verify the interval callback also calls the functions
      expect(scraperModule.scrapeUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.upsertMovies).toHaveBeenCalledTimes(1);
    });
    it('should log and keep scheduling when a run fails', async () => {
      const error = new Error('Could not get quality profile ID.');
      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: [], listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockRejectedValue(error);

      startScheduledMonitoring();

      // Let the immediate run settle
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Sync run failed');

      jest.advanceTimersByTime(600000);
      await Promise.resolve();

      expect(scraperModule.scrapeUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('main', () => {
    it('should call startScheduledMonitoring', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue({ movies: mockMovies, listType: "watchlist", complete: true });
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      await main();
      await Promise.resolve();

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(scraperModule.scrapeUrl).toHaveBeenCalled();
      expect(radarrModule.upsertMovies).toHaveBeenCalled();
    });
  });

  describe('removal of movies no longer on the list', () => {
    const movies = [
      { id: 1, name: 'A', slug: '/film/a/', tmdbId: '1', imdbId: null, publishedYear: null },
    ];

    async function runOnce(scrape: object) {
      (scraperModule.scrapeUrl as jest.Mock).mockResolvedValue(scrape);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (radarrModule.removeMissingMovies as jest.Mock).mockResolvedValue(undefined);
      startScheduledMonitoring();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    afterEach(() => {
      (env as any).RADARR_REMOVE_MISSING = 'off';
    });

    it('does not remove anything when the feature is off', async () => {
      await runOnce({ movies, listType: 'watchlist', complete: true });
      expect(radarrModule.removeMissingMovies).not.toHaveBeenCalled();
    });

    it('removes after upserting when enabled and the scrape is complete', async () => {
      (env as any).RADARR_REMOVE_MISSING = 'delete';
      await runOnce({ movies, listType: 'watchlist', complete: true });
      expect(radarrModule.removeMissingMovies).toHaveBeenCalledWith(movies, 'delete');
    });

    it('skips removal when the scrape is incomplete', async () => {
      (env as any).RADARR_REMOVE_MISSING = 'unmonitor';
      await runOnce({ movies, listType: 'watchlist', complete: false });
      expect(radarrModule.removeMissingMovies).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping removal'));
    });

    it('skips removal when the list comes back empty', async () => {
      (env as any).RADARR_REMOVE_MISSING = 'delete';
      await runOnce({ movies: [], listType: 'watchlist', complete: true });
      expect(radarrModule.removeMissingMovies).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Skipping removal: the list came back empty.');
    });
  });
});
