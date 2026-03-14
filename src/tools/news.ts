import YahooFinance from 'yahoo-finance2';
import { NewsInputSchema, NewsOutputSchema } from '../schemas/index.js';
import { YahooFinanceError, YF_ERR_DATA_INCOMPLETE, YF_ERR_DATA_UNAVAILABLE } from '../types/errors.js';
import { DataQualityReporter } from '../utils/data-completion.js';
import type { NewsItem, NewsResult } from '../types/yahoo-finance.js';
import { InputValidator } from '../utils/security.js';

// Prevent stdout notices (e.g. survey URLs) from corrupting the MCP JSON-RPC stream.
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const NEWS_CACHE_TTL = 300000;

async function fetchNewsViaYahooSearchEndpoint(symbol: string, count: number): Promise<NewsResult> {
  const url = new URL('https://query2.finance.yahoo.com/v1/finance/search');
  url.searchParams.set('q', symbol);
  url.searchParams.set('newsCount', String(Math.max(count, 10)));
  url.searchParams.set('quotesCount', '0');
  url.searchParams.set('enableFuzzyQuery', 'false');

  const response = await fetch(url.toString(), {
    headers: {
      // Yahoo can be picky about default UA; set a browser-like value.
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo search endpoint failed (${response.status})`);
  }

  const data = (await response.json()) as { news?: unknown };
  const news = Array.isArray(data.news) ? (data.news as NewsItem[]) : [];
  return { count: news.length, news: news.slice(0, count) };
}

class NewsToolCache {
  private cache: Map<string, { data: NewsResult; timestamp: number }>;

  constructor() {
    this.cache = new Map();
  }

  get(key: string): { data: NewsResult; timestamp: number } | null {
    const entry = this.cache.get(key);
    if (!entry) {return null;}
    if (Date.now() - entry.timestamp > NEWS_CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, data: NewsResult): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  generateCacheKey(symbol: string, limit: number, requireRelated: boolean): string {
    return `news:${symbol}:${limit}:${requireRelated}`;
  }

  clear(): void {
    this.cache.clear();
  }
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function convertNewsItem(item: Record<string, unknown>): {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number;
  type: string;
  publishDate: string;
  urlValid: boolean;
  relatedTickers: string[];
} {
  const link = typeof item.link === 'string' ? item.link : '';
  const providerPublishTime = typeof item.providerPublishTime === 'number' ? item.providerPublishTime : 0;
  const relatedTickers = Array.isArray(item.relatedTickers) ? item.relatedTickers : [];

  return {
    uuid: typeof item.uuid === 'string' ? item.uuid : '',
    title: typeof item.title === 'string' ? item.title : '',
    publisher: typeof item.publisher === 'string' ? item.publisher : '',
    link,
    providerPublishTime,
    type: typeof item.type === 'string' ? item.type : 'article',
    publishDate: providerPublishTime > 0 ? new Date(providerPublishTime * 1000).toISOString() : '',
    urlValid: isValidUrl(link),
    relatedTickers
  };
}

async function fetchNews(symbol: string, count: number = 10): Promise<NewsResult> {
  try {
    // Prefer the underlying Yahoo endpoint directly.
    // yahoo-finance2's search() is currently prone to noisy schema-validation logging which
    // pollutes stderr and is confusing during MCP stdio runs.
    return await fetchNewsViaYahooSearchEndpoint(symbol, count);
  } catch (error) {
    // Fallback: some yahoo-finance2 builds expose a dedicated `news()` helper.
    try {
      const maybeNewsFn = (yahooFinance as unknown as { news?: (s: string, o?: unknown) => Promise<unknown> }).news;
      if (typeof maybeNewsFn === 'function') {
        const fallback = await maybeNewsFn(symbol, { count } as unknown);
        if (Array.isArray(fallback)) {
          return { count: fallback.length, news: fallback.slice(0, count) as NewsItem[] };
        }
        const newsData = (fallback as { news?: unknown } | null)?.news;
        if (Array.isArray(newsData)) {
          return { count: newsData.length, news: newsData.slice(0, count) as NewsItem[] };
        }
      }
    } catch {
      // Ignore fallback errors; we'll report the original error below.
    }

    throw new YahooFinanceError(
      `Failed to fetch news for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      YF_ERR_DATA_UNAVAILABLE,
      null,
      true,
      false,
      { symbol, count },
      'Retry request or check symbol validity'
    );
  }
}

async function getNewsData(
  symbol: string,
  limit: number,
  requireRelatedTickers: boolean,
  cache: NewsToolCache
): Promise<{
  news: Array<{
    uuid: string;
    title: string;
    publisher: string;
    link: string;
    providerPublishTime: number;
    type: string;
    publishDate: string;
    urlValid: boolean;
    relatedTickers: string[];
  }>;
  count: number;
  fromCache: boolean;
}> {
  const cacheKey = cache.generateCacheKey(symbol, limit, requireRelatedTickers);
  const cached = cache.get(cacheKey);

  if (cached) {
    const convertedNews = cached.data.news.map(convertNewsItem);
    const filteredNews = requireRelatedTickers
      ? convertedNews.filter((item) => item.relatedTickers.length > 0)
      : convertedNews;

    return {
      news: filteredNews.slice(0, limit),
      count: filteredNews.length,
      fromCache: true
    };
  }

  const data = await fetchNews(symbol, Math.max(limit * 2, 20));
  const convertedNews = data.news.map(convertNewsItem);
  const filteredNews = requireRelatedTickers
    ? convertedNews.filter((item) => item.relatedTickers.length > 0)
    : convertedNews;

  cache.set(cacheKey, data);

  return {
    news: filteredNews.slice(0, limit),
    count: filteredNews.length,
    fromCache: false
  };
}

function buildNewsMetadata(
  fromCache: boolean,
  dataAge: number,
  newsItems: Array<{
    providerPublishTime: number;
    urlValid: boolean;
  }>,
  requestedLimit: number,
  returnedCount: number,
  requireRelated: boolean
): {
  fromCache: boolean;
  dataAge: number;
  completenessScore: number;
  warnings: string[];
  dataSource: string;
  lastUpdated: string;
  oldestArticleAge: number | null;
  newestArticleAge: number | null;
} {
  const warnings: string[] = [];
  const now = Date.now();

  if (newsItems.length === 0) {
    warnings.push('No news articles available for this symbol');
  } else if (newsItems.length < requestedLimit && !requireRelated) {
    warnings.push(`Fewer articles available than requested (${newsItems.length} of ${requestedLimit})`);
  }

  if (requireRelated && newsItems.length < requestedLimit) {
    warnings.push(`Fewer articles with related tickers available than requested (${newsItems.length} of ${requestedLimit})`);
  }

  const invalidUrls = newsItems.filter((item) => !item.urlValid).length;
  if (invalidUrls > 0) {
    warnings.push(`${invalidUrls} article(s) have invalid URLs`);
  }

  const validPublishTimes = newsItems.filter((item) => item.providerPublishTime > 0);

  if (validPublishTimes.length === 0 && newsItems.length > 0) {
    warnings.push('All articles have missing publish timestamps');
  }

  let oldestArticleAge: number | null = null;
  let newestArticleAge: number | null = null;

  if (validPublishTimes.length > 0) {
    const publishTimes = validPublishTimes.map((item) => item.providerPublishTime * 1000);
    const oldest = Math.min(...publishTimes);
    const newest = Math.max(...publishTimes);
    oldestArticleAge = now - oldest;
    newestArticleAge = now - newest;

    if (newestArticleAge > NEWS_CACHE_TTL * 2) {
      warnings.push('Most recent article is older than 10 minutes');
    } else if (newestArticleAge > NEWS_CACHE_TTL) {
      warnings.push('Most recent article is older than 5 minutes');
    }

    if (oldestArticleAge > 86400000) {
      warnings.push('Oldest article is older than 24 hours');
    }
  }

  if (dataAge > NEWS_CACHE_TTL * 0.75) {
    warnings.push('News data is stale (older than 3.75 minutes)');
  } else if (dataAge > NEWS_CACHE_TTL * 0.5) {
    warnings.push('News data may be slightly stale (older than 2.5 minutes)');
  }

  const completenessScore = returnedCount > 0 ? Math.min(returnedCount / requestedLimit, 1) : 0;
  const lastUpdated = new Date(Date.now() - dataAge).toISOString();

  return {
    fromCache,
    dataAge,
    completenessScore,
    warnings,
    dataSource: 'Yahoo Finance',
    lastUpdated,
    oldestArticleAge,
    newestArticleAge
  };
}

const newsToolCache = new NewsToolCache();

export async function getCompanyNewsTool(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const parsed = NewsInputSchema.parse(args);
  const { symbol, limit = 10, startDate, requireRelatedTickers = false } = parsed;

  InputValidator.validateSymbol(symbol);

  if (startDate) {
    InputValidator.validateDate(startDate, 'startDate');
  }

  const cacheKey = newsToolCache.generateCacheKey(symbol, limit, requireRelatedTickers);
  const cachedEntry = newsToolCache.get(cacheKey);
  const fromCache = cachedEntry !== null;
  const startTime = Date.now();

  const data = await getNewsData(symbol, limit, requireRelatedTickers, newsToolCache);

  const dataAge = fromCache && cachedEntry ? startTime - cachedEntry.timestamp : 0;

  let filteredNews = data.news;

  if (startDate) {
    const start = new Date(startDate).getTime();
    filteredNews = data.news.filter((item) => {
      if (item.providerPublishTime === 0) {return false;}
      return item.providerPublishTime * 1000 >= start;
    });
  }

  const meta = buildNewsMetadata(
    fromCache,
    dataAge,
    filteredNews,
    limit,
    filteredNews.length,
    requireRelatedTickers
  );

  const output = {
    symbol,
    news: filteredNews,
    count: filteredNews.length,
    meta
  };

  return NewsOutputSchema.parse(output);
}

export function getNewsToolDefinitions() {
  return [
    {
      name: 'get_company_news',
      description: 'Retrieve recent news articles for a company including title, publisher, link, and related tickers. Handles cases where news API fails silently and reports data freshness.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)',
            minLength: 1,
            maxLength: 20
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 50,
            description: 'Maximum number of news articles to return (default: 10)'
          },
          startDate: {
            type: 'string',
            description: 'Filter news articles published on or after this date (ISO 8601 format: YYYY-MM-DD)'
          },
          requireRelatedTickers: {
            type: 'boolean',
            description: 'Only include articles that have related tickers (default: false)'
          }
        },
        required: ['symbol']
      }
    }
  ];
}

export function clearNewsCache(): void {
  newsToolCache.clear();
}
