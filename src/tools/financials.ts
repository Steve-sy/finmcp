import YahooFinance from 'yahoo-finance2';
import { FinancialsInputSchema, FinancialsOutputSchema } from '../schemas/index.js';
import { YahooFinanceError, YF_ERR_DATA_INCOMPLETE } from '../types/errors.js';
import { DataQualityReporter } from '../utils/data-completion.js';
import type { FinancialStatementResult, BalanceSheet, IncomeStatement, CashFlowStatement } from '../types/yahoo-finance.js';
import type { CacheConfig } from '../types/config.js';
import { InputValidator } from '../utils/security.js';

type FinancialsToolConfig = {
  cache: CacheConfig;
  defaultTTL: number;
};

type StatementData = {
  period: string;
  startDate: string;
  endDate: string;
  [key: string]: number | string | null;
};

type StatementWithMeta = {
  statements: StatementData[];
  meta: {
    fromCache: boolean;
    dataAge: number;
    completenessScore: number;
    warnings: string[];
    recency: string;
  };
};

const DEFAULT_LIMIT = 4;
const CACHE_TTL = 86400000;
const EXPECTED_BS_FIELDS = [
  'totalAssets',
  'totalLiab',
  'totalStockholderEquity',
  'cash',
  'shortTermInvestments',
  'netReceivables',
  'inventory',
  'totalCurrentAssets',
  'totalCurrentLiabilities',
  'longTermDebt',
  'propertyPlantEquipment',
  'goodWill',
  'intangibleAssets'
];

const EXPECTED_IS_FIELDS = [
  'totalRevenue',
  'costOfRevenue',
  'grossProfit',
  'operatingIncome',
  'ebitda',
  'netIncome',
  'epsBasic',
  'epsDiluted',
  'interestExpense',
  'taxProvision',
  'researchAndDevelopment',
  'sellingGeneralAndAdministrative'
];

const EXPECTED_CF_FIELDS = [
  'totalCashFromOperatingActivities',
  'capitalExpenditures',
  'totalCashFromFinancingActivities',
  'totalCashFromInvestingActivities',
  'depreciation',
  'dividendsPaid',
  'stockRepurchases',
  'changeInCash',
  'freeCashFlow'
];

class FinancialsToolCache {
  private cache: Map<string, { data: StatementWithMeta; timestamp: number }>;
  private ttl: number;

  constructor(ttl: number = CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key: string): StatementWithMeta | null {
    const entry = this.cache.get(key);
    if (!entry) {return null;}
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: StatementWithMeta): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  generateCacheKey(symbol: string, type: string, frequency: string): string {
    return `financials:${symbol}:${type}:${frequency}`;
  }

  clear(): void {
    this.cache.clear();
  }
}

function extractField(item: Record<string, unknown>, fieldName: string): number | null {
  if (item[fieldName] === undefined || item[fieldName] === null) {
    return null;
  }
  const field = item[fieldName];
  if (typeof field === 'number') {
    return field;
  }
  if (typeof field === 'object' && field !== null && 'raw' in field) {
    const raw = (field as { raw: unknown }).raw;
    return typeof raw === 'number' ? raw : null;
  }
  return null;
}

function extractStringField(item: Record<string, unknown>, fieldName: string): string | null {
  if (item[fieldName] === undefined || item[fieldName] === null) {
    return null;
  }
  const field = item[fieldName];
  if (typeof field === 'string') {
    return field;
  }
  // yahoo-finance2 v3 returns Date objects for date fields (e.g. fundamentalsTimeSeries).
  if (field instanceof Date) {
    return field.toISOString();
  }
  if (typeof field === 'number') {
    // Some yahoo-finance2 responses return epoch seconds for dates.
    return new Date(field * 1000).toISOString();
  }
  if (typeof field === 'object' && field !== null && 'fmt' in field) {
    return String((field as { fmt: unknown }).fmt);
  }
  if (typeof field === 'object' && field !== null && 'raw' in field) {
    const raw = (field as { raw: unknown }).raw;
    if (typeof raw === 'number') {
      return new Date(raw * 1000).toISOString();
    }
  }
  return null;
}

function extractDateField(item: Record<string, unknown>): string | null {
  // Yahoo payloads vary between modules; try a few common keys.
  // 'date' is used by fundamentalsTimeSeries; 'endDate' by older quoteSummary modules.
  const candidates = ['date', 'endDate', 'asOfDate', 'periodEnding'];
  for (const key of candidates) {
    const v = extractStringField(item, key);
    if (v) {return v;}
  }
  return null;
}

function normalizeDateToYmd(value: string | null): string {
  if (!value) {return '1970-01-01';}
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {return value;}
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) {
    // Try epoch string
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      const ms = asNum < 10_000_000_000 ? asNum * 1000 : asNum;
      const dd = new Date(ms);
      if (Number.isFinite(dd.getTime())) {
        return dd.toISOString().split('T')[0];
      }
    }
    return '1970-01-01';
  }
  return d.toISOString().split('T')[0];
}

function buildFieldAvailability(data: Record<string, number | null>, expectedFields: string[]): Record<string, boolean> {
  const availability: Record<string, boolean> = {};
  for (const field of expectedFields) {
    availability[field] = data[field] !== null && data[field] !== undefined;
  }
  return availability;
}

function convertBalanceSheetToStatementData(item: Record<string, unknown>): StatementData {
  const endDateRaw = extractDateField(item);
  const endDate = normalizeDateToYmd(endDateRaw);
  const startDate = endDate;

  const statement: StatementData = {
    period: 'annual',
    startDate,
    endDate,
    // fundamentalsTimeSeries field names (with quoteSummary fallbacks)
    totalAssets: extractField(item, 'totalAssets'),
    totalLiab: extractField(item, 'totalLiabilitiesNetMinorityInterest') ?? extractField(item, 'totalLiab'),
    totalStockholderEquity: extractField(item, 'stockholdersEquity') ?? extractField(item, 'totalStockholderEquity'),
    cash: extractField(item, 'cashAndCashEquivalents') ?? extractField(item, 'cash'),
    shortTermInvestments: extractField(item, 'otherShortTermInvestments') ?? extractField(item, 'shortTermInvestments'),
    netReceivables: extractField(item, 'receivables') ?? extractField(item, 'accountsReceivable') ?? extractField(item, 'netReceivables'),
    inventory: extractField(item, 'inventory'),
    totalCurrentAssets: extractField(item, 'currentAssets') ?? extractField(item, 'totalCurrentAssets'),
    totalCurrentLiabilities: extractField(item, 'currentLiabilities') ?? extractField(item, 'totalCurrentLiabilities'),
    longTermDebt: extractField(item, 'longTermDebt'),
    propertyPlantEquipment: extractField(item, 'netPPE') ?? extractField(item, 'propertyPlantEquipment'),
    goodWill: extractField(item, 'goodwill') ?? extractField(item, 'goodWill'),
    intangibleAssets: extractField(item, 'otherIntangibleAssets') ?? extractField(item, 'intangibleAssets'),
    retainedEarnings: extractField(item, 'retainedEarnings'),
    otherAssets: extractField(item, 'otherNonCurrentAssets') ?? extractField(item, 'otherAssets'),
    otherLiab: extractField(item, 'otherNonCurrentLiabilities') ?? extractField(item, 'otherLiab')
  };

  return statement;
}

function convertIncomeStatementToStatementData(item: Record<string, unknown>): StatementData {
  const endDateRaw = extractDateField(item);
  const endDate = normalizeDateToYmd(endDateRaw);
  const startDate = endDate;

  const statement: StatementData = {
    period: 'annual',
    startDate,
    endDate,
    // fundamentalsTimeSeries field names (with quoteSummary fallbacks)
    totalRevenue: extractField(item, 'totalRevenue'),
    costOfRevenue: extractField(item, 'costOfRevenue') ?? extractField(item, 'reconciledCostOfRevenue'),
    grossProfit: extractField(item, 'grossProfit'),
    operatingIncome: extractField(item, 'operatingIncome'),
    ebitda: extractField(item, 'EBITDA') ?? extractField(item, 'ebitda'),
    netIncome: extractField(item, 'netIncome'),
    epsBasic: extractField(item, 'basicEPS') ?? extractField(item, 'epsBasic'),
    epsDiluted: extractField(item, 'dilutedEPS') ?? extractField(item, 'epsDiluted'),
    interestExpense: extractField(item, 'interestExpense'),
    taxProvision: extractField(item, 'taxProvision') ?? extractField(item, 'incomeTaxExpense'),
    researchAndDevelopment: extractField(item, 'researchAndDevelopment') ?? extractField(item, 'researchDevelopment'),
    sellingGeneralAndAdministrative: extractField(item, 'sellingGeneralAndAdministration') ?? extractField(item, 'sellingGeneralAndAdministrative') ?? extractField(item, 'sellingGeneralAdministrative'),
    operatingExpense: extractField(item, 'operatingExpense'),
    otherOperatingExpenses: extractField(item, 'otherOperatingExpenses'),
    nonRecurringEvents: null,
    nonOperatingInterestIncome: extractField(item, 'netNonOperatingInterestIncomeExpense') ?? extractField(item, 'nonOperatingInterestIncome'),
    otherIncomeExpense: extractField(item, 'otherIncomeExpense')
  };

  return statement;
}

function convertCashFlowToStatementData(item: Record<string, unknown>): StatementData {
  const endDateRaw = extractDateField(item);
  const endDate = normalizeDateToYmd(endDateRaw);
  const startDate = endDate;

  const statement: StatementData = {
    period: 'annual',
    startDate,
    endDate,
    // fundamentalsTimeSeries field names (with quoteSummary fallbacks)
    totalCashFromOperatingActivities: extractField(item, 'operatingCashFlow') ?? extractField(item, 'cashFlowFromContinuingOperatingActivities') ?? extractField(item, 'totalCashFromOperatingActivities'),
    capitalExpenditures: extractField(item, 'capitalExpenditure') ?? extractField(item, 'capitalExpenditures'),
    totalCashFromFinancingActivities: extractField(item, 'financingCashFlow') ?? extractField(item, 'cashFlowFromContinuingFinancingActivities') ?? extractField(item, 'totalCashFromFinancingActivities'),
    totalCashFromInvestingActivities: extractField(item, 'investingCashFlow') ?? extractField(item, 'cashFlowFromContinuingInvestingActivities') ?? extractField(item, 'totalCashFromInvestingActivities'),
    depreciation: extractField(item, 'depreciationAndAmortization') ?? extractField(item, 'depreciation'),
    dividendsPaid: extractField(item, 'cashDividendsPaid') ?? extractField(item, 'commonStockDividendPaid') ?? extractField(item, 'dividendsPaid'),
    stockRepurchases: extractField(item, 'repurchaseOfCapitalStock') ?? extractField(item, 'commonStockPayments') ?? extractField(item, 'stockRepurchases'),
    changeInCash: extractField(item, 'changesInCash') ?? extractField(item, 'changeInCash'),
    freeCashFlow: extractField(item, 'freeCashFlow'),
    netBorrowings: extractField(item, 'netIssuancePaymentsOfDebt') ?? extractField(item, 'netBorrowings'),
    otherCashflowsFromInvestingActivities: extractField(item, 'netOtherInvestingChanges') ?? extractField(item, 'otherCashflowsFromInvestingActivities'),
    otherCashflowsFromFinancingActivities: extractField(item, 'netOtherFinancingCharges') ?? extractField(item, 'otherCashflowsFromFinancingActivities'),
    effectOfExchangeRateOnCash: extractField(item, 'effectOfExchangeRateOnCash')
  };

  return statement;
}

function buildStatementMetadata(
  statements: StatementData[],
  fromCache: boolean,
  dataAge: number,
  expectedFields: string[]
): StatementWithMeta['meta'] {
  const qualityReporter = new DataQualityReporter(CACHE_TTL);
  const warnings: string[] = [];

  let totalFields = 0;
  let availableFields = 0;

  for (const statement of statements) {
    for (const field of expectedFields) {
      totalFields++;
      if (statement[field] !== null && statement[field] !== undefined) {
        availableFields++;
      }
    }
  }

  const completenessScore = totalFields > 0 ? availableFields / totalFields : 0;

  if (completenessScore < 0.5) {
    warnings.push('Data completeness is low (< 50% fields available)');
  } else if (completenessScore < 0.8) {
    warnings.push('Some financial data fields are missing');
  }

  if (dataAge > CACHE_TTL * 0.5) {
    warnings.push('Financial data is stale (older than 12 hours)');
  }

  const latestDate = statements.length > 0 ? statements[0].endDate : '';
  const recency = latestDate || new Date().toISOString().split('T')[0];

  return {
    fromCache,
    dataAge,
    completenessScore,
    warnings,
    recency
  };
}

async function fetchBalanceSheet(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual'
): Promise<BalanceSheet> {
  try {
    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // quoteSummary balanceSheetHistory stopped returning financial data in Nov 2024.
    // Use fundamentalsTimeSeries instead.
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    let raw: unknown;
    try {
      raw = await (yf as any).fundamentalsTimeSeries(symbol, { module: 'balance-sheet', type: frequency, period1 });
    } catch (err) {
      // FailedYahooValidationError: use the partial .result (some entries may have TYPE: 'UNKNOWN')
      if (err instanceof Error && err.constructor.name === 'FailedYahooValidationError') {
        raw = (err as Error & { result: unknown }).result;
      } else {
        throw err;
      }
    }
    // Filter out UNKNOWN entries and sort newest-first so slice(0, limit) returns recent data.
    const statements = Array.isArray(raw)
      ? (raw as any[])
          .filter((e) => e?.TYPE === 'BALANCE_SHEET' || (e?.TYPE !== 'CASH_FLOW' && e?.TYPE !== 'FINANCIALS' && e?.totalAssets !== undefined))
          .sort((a, b) => (b.date instanceof Date ? b.date.getTime() : b.date) - (a.date instanceof Date ? a.date.getTime() : a.date))
      : [];

    if (!Array.isArray(statements) || statements.length === 0) {
      throw new YahooFinanceError(
        `Balance sheet data not available for ${symbol}`,
        YF_ERR_DATA_INCOMPLETE,
        null,
        false,
        false,
        { symbol, frequency },
        'Try quarterly frequency or check if symbol is valid'
      );
    }

    return {
      maxAge: 0,
      annual: frequency === 'annual' ? (statements as any[]) : [],
      quarterly: frequency === 'quarterly' ? (statements as any[]) : []
    } as BalanceSheet;
  } catch (error) {
    if (error instanceof YahooFinanceError) {
      throw error;
    }
    throw new YahooFinanceError(
      `Failed to fetch balance sheet for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      true,
      false,
      { symbol, frequency },
      'Retry the request or try quarterly frequency'
    );
  }
}

async function fetchIncomeStatement(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual'
): Promise<IncomeStatement> {
  try {
    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // quoteSummary incomeStatementHistory stopped returning most fields in Nov 2024.
    // Use fundamentalsTimeSeries instead.
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    let raw: unknown;
    try {
      raw = await (yf as any).fundamentalsTimeSeries(symbol, { module: 'financials', type: frequency, period1 });
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'FailedYahooValidationError') {
        raw = (err as Error & { result: unknown }).result;
      } else {
        throw err;
      }
    }
    const statements = Array.isArray(raw)
      ? (raw as any[])
          .filter((e) => e?.TYPE === 'FINANCIALS' || e?.totalRevenue !== undefined)
          .sort((a, b) => (b.date instanceof Date ? b.date.getTime() : b.date) - (a.date instanceof Date ? a.date.getTime() : a.date))
      : [];

    if (!Array.isArray(statements) || statements.length === 0) {
      throw new YahooFinanceError(
        `Income statement data not available for ${symbol}`,
        YF_ERR_DATA_INCOMPLETE,
        null,
        false,
        false,
        { symbol, frequency },
        'Try quarterly frequency or check if symbol is valid'
      );
    }

    return {
      maxAge: 0,
      annual: frequency === 'annual' ? (statements as any[]) : [],
      quarterly: frequency === 'quarterly' ? (statements as any[]) : []
    } as IncomeStatement;
  } catch (error) {
    if (error instanceof YahooFinanceError) {
      throw error;
    }
    throw new YahooFinanceError(
      `Failed to fetch income statement for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      true,
      false,
      { symbol, frequency },
      'Retry the request or try quarterly frequency'
    );
  }
}

async function fetchCashFlowStatement(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual'
): Promise<CashFlowStatement> {
  try {
    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // quoteSummary cashflowStatementHistory stopped returning most fields in Nov 2024.
    // Use fundamentalsTimeSeries instead.
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    let raw: unknown;
    try {
      raw = await (yf as any).fundamentalsTimeSeries(symbol, { module: 'cash-flow', type: frequency, period1 });
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'FailedYahooValidationError') {
        raw = (err as Error & { result: unknown }).result;
      } else {
        throw err;
      }
    }
    const statements = Array.isArray(raw)
      ? (raw as any[])
          .filter((e) => e?.TYPE === 'CASH_FLOW' || e?.operatingCashFlow !== undefined)
          .sort((a, b) => (b.date instanceof Date ? b.date.getTime() : b.date) - (a.date instanceof Date ? a.date.getTime() : a.date))
      : [];

    if (!Array.isArray(statements) || statements.length === 0) {
      throw new YahooFinanceError(
        `Cash flow statement data not available for ${symbol}`,
        YF_ERR_DATA_INCOMPLETE,
        null,
        false,
        false,
        { symbol, frequency },
        'Try quarterly frequency or check if symbol is valid'
      );
    }

    return {
      maxAge: 0,
      annual: frequency === 'annual' ? (statements as any[]) : [],
      quarterly: frequency === 'quarterly' ? (statements as any[]) : []
    } as CashFlowStatement;
  } catch (error) {
    if (error instanceof YahooFinanceError) {
      throw error;
    }
    throw new YahooFinanceError(
      `Failed to fetch cash flow statement for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      true,
      false,
      { symbol, frequency },
      'Retry the request or try quarterly frequency'
    );
  }
}

async function getBalanceSheet(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual',
  limit: number = DEFAULT_LIMIT,
  cache: FinancialsToolCache
): Promise<StatementWithMeta> {
  const cacheKey = cache.generateCacheKey(symbol, 'balance-sheet', frequency);
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const data = await fetchBalanceSheet(symbol, frequency);
  const statementsData = frequency === 'annual' ? data.annual : data.quarterly;

  if (!statementsData || statementsData.length === 0) {
    if (frequency === 'annual') {
      const quarterlyData = await fetchBalanceSheet(symbol, 'quarterly');
      const quarterlyStatements = quarterlyData.quarterly;
      if (quarterlyStatements && quarterlyStatements.length > 0) {
        const statements = quarterlyStatements
          .slice(0, limit)
          .map((item) => convertBalanceSheetToStatementData(item as unknown as Record<string, unknown>));

        for (const stmt of statements) {
          stmt.period = 'quarterly';
        }

        const meta = buildStatementMetadata(statements, false, 0, EXPECTED_BS_FIELDS);
        const result = { statements, meta };
        cache.set(cacheKey, result);
        return result;
      }
    }

    throw new YahooFinanceError(
      `No balance sheet data available for ${symbol}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      false,
      false,
      { symbol, frequency },
      'Verify the symbol exists and has financial data available'
    );
  }

  const statements = statementsData
    .slice(0, limit)
    .map((item) => convertBalanceSheetToStatementData(item as unknown as Record<string, unknown>));

  const meta = buildStatementMetadata(statements, false, 0, EXPECTED_BS_FIELDS);
  const result = { statements, meta };
  cache.set(cacheKey, result);
  return result;
}

async function getIncomeStatement(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual',
  limit: number = DEFAULT_LIMIT,
  cache: FinancialsToolCache
): Promise<StatementWithMeta> {
  const cacheKey = cache.generateCacheKey(symbol, 'income-statement', frequency);
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const data = await fetchIncomeStatement(symbol, frequency);
  const statementsData = frequency === 'annual' ? data.annual : data.quarterly;

  if (!statementsData || statementsData.length === 0) {
    if (frequency === 'annual') {
      const quarterlyData = await fetchIncomeStatement(symbol, 'quarterly');
      const quarterlyStatements = quarterlyData.quarterly;
      if (quarterlyStatements && quarterlyStatements.length > 0) {
        const statements = quarterlyStatements
          .slice(0, limit)
          .map((item) => convertIncomeStatementToStatementData(item as unknown as Record<string, unknown>));

        for (const stmt of statements) {
          stmt.period = 'quarterly';
        }

        const meta = buildStatementMetadata(statements, false, 0, EXPECTED_IS_FIELDS);
        const result = { statements, meta };
        cache.set(cacheKey, result);
        return result;
      }
    }

    throw new YahooFinanceError(
      `No income statement data available for ${symbol}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      false,
      false,
      { symbol, frequency },
      'Verify the symbol exists and has financial data available'
    );
  }

  const statements = statementsData
    .slice(0, limit)
    .map((item) => convertIncomeStatementToStatementData(item as unknown as Record<string, unknown>));

  const meta = buildStatementMetadata(statements, false, 0, EXPECTED_IS_FIELDS);
  const result = { statements, meta };
  cache.set(cacheKey, result);
  return result;
}

async function getCashFlowStatement(
  symbol: string,
  frequency: 'annual' | 'quarterly' = 'annual',
  limit: number = DEFAULT_LIMIT,
  cache: FinancialsToolCache
): Promise<StatementWithMeta> {
  const cacheKey = cache.generateCacheKey(symbol, 'cash-flow', frequency);
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const data = await fetchCashFlowStatement(symbol, frequency);
  const statementsData = frequency === 'annual' ? data.annual : data.quarterly;

  if (!statementsData || statementsData.length === 0) {
    if (frequency === 'annual') {
      const quarterlyData = await fetchCashFlowStatement(symbol, 'quarterly');
      const quarterlyStatements = quarterlyData.quarterly;
      if (quarterlyStatements && quarterlyStatements.length > 0) {
        const statements = quarterlyStatements
          .slice(0, limit)
          .map((item) => convertCashFlowToStatementData(item as unknown as Record<string, unknown>));

        for (const stmt of statements) {
          stmt.period = 'quarterly';
        }

        const meta = buildStatementMetadata(statements, false, 0, EXPECTED_CF_FIELDS);
        const result = { statements, meta };
        cache.set(cacheKey, result);
        return result;
      }
    }

    throw new YahooFinanceError(
      `No cash flow statement data available for ${symbol}`,
      YF_ERR_DATA_INCOMPLETE,
      null,
      false,
      false,
      { symbol, frequency },
      'Verify the symbol exists and has financial data available'
    );
  }

  const statements = statementsData
    .slice(0, limit)
    .map((item) => convertCashFlowToStatementData(item as unknown as Record<string, unknown>));

  const meta = buildStatementMetadata(statements, false, 0, EXPECTED_CF_FIELDS);
  const result = { statements, meta };
  cache.set(cacheKey, result);
  return result;
}

const financialsToolCache = new FinancialsToolCache(CACHE_TTL);

export async function getBalanceSheetTool(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const parsed = FinancialsInputSchema.parse(args);
  const { symbol, frequency = 'annual', limit = DEFAULT_LIMIT } = parsed;

  const result = await getBalanceSheet(symbol, frequency, limit, financialsToolCache);

  const statements = result.statements.map((stmt) => ({
    period: stmt.period,
    startDate: stmt.startDate,
    endDate: stmt.endDate,
    balanceSheet: Object.fromEntries(
      Object.entries(stmt).filter(([key]) => !['period', 'startDate', 'endDate'].includes(key))
    ),
    fieldAvailability: buildFieldAvailability(stmt as Record<string, number | null>, EXPECTED_BS_FIELDS)
  }));

  const output = {
    symbol,
    statements,
    meta: result.meta
  };

  return FinancialsOutputSchema.parse(output);
}

export async function getIncomeStatementTool(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const parsed = FinancialsInputSchema.parse(args);
  const { symbol, frequency = 'annual', limit = DEFAULT_LIMIT } = parsed;

  InputValidator.validateSymbol(symbol);

  if (frequency) {
    InputValidator.validateString(frequency, 'frequency');
  }

  const result = await getIncomeStatement(symbol, frequency, limit, financialsToolCache);

  const statements = result.statements.map((stmt) => ({
    period: stmt.period,
    startDate: stmt.startDate,
    endDate: stmt.endDate,
    incomeStatement: Object.fromEntries(
      Object.entries(stmt).filter(([key]) => !['period', 'startDate', 'endDate'].includes(key))
    ),
    fieldAvailability: buildFieldAvailability(stmt as Record<string, number | null>, EXPECTED_IS_FIELDS)
  }));

  const output = {
    symbol,
    statements,
    meta: result.meta
  };

  return FinancialsOutputSchema.parse(output);
}

export async function getCashFlowStatementTool(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const parsed = FinancialsInputSchema.parse(args);
  const { symbol, frequency = 'annual', limit = DEFAULT_LIMIT } = parsed;

  InputValidator.validateSymbol(symbol);

  if (frequency) {
    InputValidator.validateString(frequency, 'frequency');
  }

  const result = await getCashFlowStatement(symbol, frequency, limit, financialsToolCache);

  const statements = result.statements.map((stmt) => ({
    period: stmt.period,
    startDate: stmt.startDate,
    endDate: stmt.endDate,
    cashFlowStatement: Object.fromEntries(
      Object.entries(stmt).filter(([key]) => !['period', 'startDate', 'endDate'].includes(key))
    ),
    fieldAvailability: buildFieldAvailability(stmt as Record<string, number | null>, EXPECTED_CF_FIELDS)
  }));

  const output = {
    symbol,
    statements,
    meta: result.meta
  };

  return FinancialsOutputSchema.parse(output);
}

export function getFinancialsToolDefinitions() {
  return [
    {
      name: 'get_balance_sheet',
      description: 'Retrieve balance sheet financial statements for a company including assets, liabilities, and equity data. Returns both annual and quarterly periods with field availability tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)',
            minLength: 1,
            maxLength: 20
          },
          frequency: {
            type: 'string',
            enum: ['annual', 'quarterly'],
            description: 'Reporting frequency (default: annual)'
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            description: 'Maximum number of periods to return (default: 4)'
          }
        },
        required: ['symbol']
      }
    },
    {
      name: 'get_income_statement',
      description: 'Retrieve income statement financial statements for a company including revenue, expenses, and earnings data. Provides EPS data and attempts fallback to quarterly if annual fails.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)',
            minLength: 1,
            maxLength: 20
          },
          frequency: {
            type: 'string',
            enum: ['annual', 'quarterly'],
            description: 'Reporting frequency (default: annual)'
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            description: 'Maximum number of periods to return (default: 4)'
          }
        },
        required: ['symbol']
      }
    },
    {
      name: 'get_cash_flow_statement',
      description: 'Retrieve cash flow statement financial statements for a company including operating, investing, and financing activities. Tracks free cash flow and capital expenditures.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)',
            minLength: 1,
            maxLength: 20
          },
          frequency: {
            type: 'string',
            enum: ['annual', 'quarterly'],
            description: 'Reporting frequency (default: annual)'
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            description: 'Maximum number of periods to return (default: 4)'
          }
        },
        required: ['symbol']
      }
    }
  ];
}

export function clearFinancialsCache(): void {
  financialsToolCache.clear();
}
