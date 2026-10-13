const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  "http://127.0.0.1:7777/api";

export type Role = "trader" | "viewer";

export type AuthUser = {
  id: number;
  username: string;
  email: string;
  role: Role;
  date_joined: string;
};

export type AuthTokens = {
  access: string;
  refresh: string;
};

const ACCESS_KEY = "ta_access";
const REFRESH_KEY = "ta_refresh";

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(tokens: AuthTokens) {
  localStorage.setItem(ACCESS_KEY, tokens.access);
  localStorage.setItem(REFRESH_KEY, tokens.refresh);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

const REFRESH_SKEW_MS = 60_000;
let refreshInFlight: Promise<string> | null = null;

function jwtExpMs(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function accessIsExpiring(token: string | null): boolean {
  if (!token) return true;
  const exp = jwtExpMs(token);
  if (exp == null) return false;
  return exp - Date.now() <= REFRESH_SKEW_MS;
}

async function postRefresh(): Promise<string> {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error("Not authenticated");
  const res = await fetch(`${API_BASE}/auth/token/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
  });
  if (!res.ok) {
    clearTokens();
    throw new Error(await parseError(res));
  }
  const data = (await res.json()) as { access: string; refresh?: string };
  localStorage.setItem(ACCESS_KEY, data.access);
  if (data.refresh) localStorage.setItem(REFRESH_KEY, data.refresh);
  return data.access;
}

function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = postRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Refresh the access JWT if it is missing or within 60s of expiry. */
export async function ensureFreshAccessToken(): Promise<string | null> {
  const access = getAccessToken();
  const refresh = getRefreshToken();
  if (!access && !refresh) return null;
  if (!accessIsExpiring(access)) return access;
  if (!refresh) return access;
  try {
    return await refreshAccessToken();
  } catch {
    return null;
  }
}

async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureFreshAccessToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res = await fetch(url, { ...init, headers });
  if (res.status !== 401 || !getRefreshToken()) return res;

  try {
    const next = await refreshAccessToken();
    headers.set("Authorization", `Bearer ${next}`);
    res = await fetch(url, { ...init, headers });
  } catch {
    /* keep the original 401 */
  }
  return res;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data === "string") return data;
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) return String(data.detail[0]);
    // Prefer field-specific signup messages
    for (const key of ["username", "email", "password", "non_field_errors"]) {
      const val = data[key];
      if (Array.isArray(val) && val[0]) return String(val[0]);
      if (typeof val === "string") return val;
    }
    const first = Object.values(data)[0];
    if (Array.isArray(first)) return String(first[0]);
    if (typeof first === "string") return first;
    return "Request failed";
  } catch {
    return res.statusText || "Request failed";
  }
}

export async function apiSignup(input: {
  username: string;
  email: string;
  password: string;
  role: Role;
}): Promise<{ user: AuthUser } & AuthTokens> {
  const res = await fetch(`${API_BASE}/auth/signup/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiLogin(input: {
  username: string;
  password: string;
}): Promise<{ user: AuthUser } & AuthTokens> {
  const res = await fetch(`${API_BASE}/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiMe(): Promise<AuthUser> {
  if (!getAccessToken() && !getRefreshToken()) {
    throw new Error("Not authenticated");
  }
  const res = await authFetch(`${API_BASE}/auth/me/`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiForgotPassword(
  email: string
): Promise<{ detail: string; dev_code?: string }> {
  const res = await fetch(`${API_BASE}/auth/forgot-password/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiVerifyResetCode(input: {
  email: string;
  code: string;
}): Promise<{ detail: string }> {
  const res = await fetch(`${API_BASE}/auth/verify-reset-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiResetPassword(input: {
  email: string;
  code: string;
  new_password: string;
}): Promise<{ detail: string }> {
  const res = await fetch(`${API_BASE}/auth/reset-password/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type MarketType = "spot" | "futures" | "forex";

export type Wallet = {
  id: number;
  market: MarketType;
  balance: string;
  starting_balance: string;
  updated_at: string;
};

export type Quote = {
  market: string;
  symbol: string;
  price: string;
  bid?: string;
  ask?: string;
};

export type Position = {
  id: number;
  market: MarketType;
  symbol: string;
  side: "long" | "short";
  quantity: string;
  entry_price: string;
  notional: string;
  leverage: number;
  margin: string;
  status: "open" | "closed";
  exit_price: string | null;
  realized_pnl: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  opened_at: string;
  closed_at: string | null;
  mark_price: string | null;
  unrealized_pnl: string | null;
  liquidation_price: string | null;
};

export type SymbolHit = {
  symbol: string;
  base: string;
  quote: string;
  market: string;
  ws_stream: string;
};

export type OrderBookLevel = { price: string; qty: string };

export type OrderBook = {
  market: string;
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ws: { url: string; stream: string };
};

export type RecentTrade = {
  id: number;
  price: string;
  qty: string;
  time: number;
  isBuyerMaker: boolean;
};

export type Ticker = {
  market: string;
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  ws: { url: string; stream: string };
};

export async function apiWallets(): Promise<Wallet[]> {
  const res = await authFetch(`${API_BASE}/trading/wallets/`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiQuotes(market?: string): Promise<Quote[]> {
  const q = market ? `?market=${market}` : "";
  const res = await authFetch(`${API_BASE}/trading/quotes/${q}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiSearchSymbols(
  market: "spot" | "futures",
  q: string
): Promise<SymbolHit[]> {
  const res = await authFetch(
    `${API_BASE}/trading/symbols/?market=${market}&q=${encodeURIComponent(q)}&limit=40`,
    {}
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiOrderBook(
  market: "spot" | "futures",
  symbol: string
): Promise<OrderBook> {
  const res = await authFetch(
    `${API_BASE}/trading/orderbook/?market=${market}&symbol=${encodeURIComponent(symbol)}&limit=20`,
    {}
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiRecentTrades(
  market: "spot" | "futures",
  symbol: string
): Promise<{ trades: RecentTrade[]; ws: { url: string; stream: string } }> {
  const res = await authFetch(
    `${API_BASE}/trading/trades/?market=${market}&symbol=${encodeURIComponent(symbol)}&limit=40`,
    {}
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiTicker(
  market: "spot" | "futures",
  symbol: string
): Promise<Ticker> {
  const res = await authFetch(
    `${API_BASE}/trading/ticker/?market=${market}&symbol=${encodeURIComponent(symbol)}`,
    {}
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiPositions(
  status: "open" | "closed" | "all" = "open"
): Promise<Position[]> {
  const q = status === "all" ? "" : `?status=${status}`;
  const res = await authFetch(`${API_BASE}/trading/positions/${q}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiOpenPosition(input: {
  market: MarketType;
  symbol: string;
  side: "long" | "short";
  notional: number;
}): Promise<Position> {
  const res = await authFetch(`${API_BASE}/trading/positions/`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type OrderType = "market" | "limit";
export type OrderStatus = "open" | "filled" | "cancelled";

export type PaperOrder = {
  id: number;
  market: MarketType;
  symbol: string;
  side: "long" | "short";
  order_type: OrderType;
  notional: string;
  leverage: number;
  margin: string;
  limit_price: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  status: OrderStatus;
  position: number | null;
  created_at: string;
  filled_at: string | null;
};

export async function apiPlaceOrder(input: {
  market: MarketType;
  symbol: string;
  side: "long" | "short";
  order_type: OrderType;
  notional: number;
  leverage?: number;
  limit_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
}): Promise<PaperOrder> {
  const res = await authFetch(`${API_BASE}/trading/orders/`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiOrders(
  status: "open" | "filled" | "cancelled" | "all" = "open"
): Promise<PaperOrder[]> {
  const q = status === "all" ? "" : `?status=${status}`;
  const res = await authFetch(`${API_BASE}/trading/orders/${q}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiCancelOrder(id: number): Promise<PaperOrder> {
  const res = await authFetch(`${API_BASE}/trading/orders/${id}/cancel/`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiClosePosition(id: number): Promise<Position> {
  const res = await authFetch(`${API_BASE}/trading/positions/${id}/close/`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiAdjustPosition(
  id: number,
  input: { action: "add" | "trim"; notional: number }
): Promise<Position> {
  const res = await authFetch(`${API_BASE}/trading/positions/${id}/adjust/`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiProtectPosition(
  id: number,
  input: { stop_loss?: number | null; take_profit?: number | null }
): Promise<Position> {
  const res = await authFetch(`${API_BASE}/trading/positions/${id}/protect/`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type AppNotification = {
  id: number;
  kind: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
  created_at: string;
  actor: { id: number; username: string } | null;
};

export type NotificationsResponse = {
  unread_count: number;
  results: AppNotification[];
};

export async function apiNotifications(
  unreadOnly = false
): Promise<NotificationsResponse> {
  const q = unreadOnly ? "?unread=1" : "";
  const res = await authFetch(`${API_BASE}/auth/notifications/${q}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiMarkNotificationRead(id: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/auth/notifications/${id}/read/`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function apiMarkAllNotificationsRead(): Promise<void> {
  const res = await authFetch(`${API_BASE}/auth/notifications/read-all/`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export type TraderSummary = {
  id: number;
  username: string;
  open_positions: number;
  closed_trades: number;
  realized_pnl: string;
  followers_count?: number;
  following_count?: number;
  is_following?: boolean;
};

export type TraderHistory = {
  trader: TraderSummary;
  open: Position[];
  closed: Position[];
};

export type SocialUser = {
  id: number;
  username: string;
  role: Role;
  followed_at?: string;
};

export type SocialListResponse = {
  username: string;
  role: Role;
  count: number;
  results: SocialUser[];
};

export type MySocial = {
  followers_count: number;
  following_count: number;
  followers: SocialUser[];
  following: SocialUser[];
};

export type FollowActionResponse = {
  detail: string;
  is_following: boolean;
  followers_count: number;
  following_count: number;
};

export async function apiFollow(username: string): Promise<FollowActionResponse> {
  const res = await authFetch(
    `${API_BASE}/auth/follow/${encodeURIComponent(username)}/`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiUnfollow(
  username: string
): Promise<FollowActionResponse> {
  const res = await authFetch(
    `${API_BASE}/auth/follow/${encodeURIComponent(username)}/`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiMySocial(): Promise<MySocial> {
  const res = await authFetch(`${API_BASE}/auth/me/social/`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiFollowers(
  username: string
): Promise<SocialListResponse> {
  const res = await authFetch(
    `${API_BASE}/auth/users/${encodeURIComponent(username)}/followers/`
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiFollowing(
  username: string
): Promise<SocialListResponse> {
  const res = await authFetch(
    `${API_BASE}/auth/users/${encodeURIComponent(username)}/following/`
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiTraders(q = ""): Promise<TraderSummary[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const res = await authFetch(`${API_BASE}/trading/traders/${qs}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiTraderHistory(
  username: string
): Promise<TraderHistory> {
  const res = await authFetch(
    `${API_BASE}/trading/traders/${encodeURIComponent(username)}/`,
    {}
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type LeaderboardPeriod = "daily" | "weekly" | "all_time";
export type LeaderboardMetric = "pnl" | "roi" | "win_rate";

export type LeaderboardEntry = {
  rank: number;
  id: number;
  username: string;
  realized_pnl: string;
  roi_pct: string;
  win_rate_pct: string;
  wins: number;
  losses: number;
  closed_trades: number;
  open_positions: number;
  starting_capital: string;
};

export type LeaderboardResponse = {
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  period_start: string | null;
  count: number;
  results: LeaderboardEntry[];
};

export async function apiLeaderboard(opts: {
  period?: LeaderboardPeriod;
  metric?: LeaderboardMetric;
  limit?: number;
} = {}): Promise<LeaderboardResponse> {
  const params = new URLSearchParams();
  if (opts.period) params.set("period", opts.period);
  if (opts.metric) params.set("metric", opts.metric);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  const res = await authFetch(`${API_BASE}/trading/leaderboard/${qs}`, {
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

