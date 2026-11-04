import type {
  ArchetypeId,
  PowItem,
  PowView,
  ArchetypeView,
  RaiseView,
  GraduationAttestation,
  GraduationView,
  TokenClaim,
  SignalsEnvelope,
  Address,
  ApiErrorBody,
  BlokeDetail,
  BlokeSummary,
  ClaimAttestation,
  Envelope,
  EpochRow,
  FaucetResult,
  IndexPoint,
  Leg,
  PoolView,
  Session,
  SourcesAttestation,
  StatusView,
  Trade,
  WalletView,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** e.g. "https://api.bloke.example" or "http://localhost:8080". */
  baseUrl: string;
  /** Session token from `signIn`; browsers can rely on the httpOnly cookie instead. */
  token?: string;
  fetch?: typeof fetch;
}

/** Typed REST client for services/api (PRD §13.4). */
export class BlokeClient {
  private token: string | undefined;
  private readonly f: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.token = opts.token;
    // Bind: browsers throw "Illegal invocation" when fetch is called as a method of another object.
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token: string | undefined) {
    this.token = token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.f(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = (json ?? {}) as Partial<ApiErrorBody>;
      throw new ApiError(res.status, e.error ?? "http_error", e.message ?? res.statusText);
    }
    return json as T;
  }

  // ---------------------------------------------------------------- reads

  blokes() {
    return this.req<Envelope<BlokeSummary[]>>("GET", "/v1/blokes");
  }
  graduations() {
    return this.req<Envelope<(GraduationView & { ticker: string; name: string; archetype: ArchetypeId | null })[]>>("GET", "/v1/graduations");
  }
  graduation(ticker: string) {
    return this.req<Envelope<GraduationView>>("GET", `/v1/graduations/${encodeURIComponent(ticker)}`);
  }
  claims(wallet: string) {
    return this.req<Envelope<TokenClaim[]>>("GET", `/v1/wallets/${wallet}/claims`);
  }
  /** Signed graduation inputs for the claimed wallet, which then calls GraduationLauncher.graduate. */
  attestGraduation(ticker: string) {
    return this.req<{ data: GraduationAttestation }>("POST", `/v1/graduations/${encodeURIComponent(ticker)}/attest`, {});
  }
  /** Staging: list the signed-in wallet and get its claim attestation, ready to open a raise. */
  startRaise(body: { ticker: string; name: string; archetype: ArchetypeId }) {
    return this.req<{ data: ClaimAttestation & { ticker: string } }>("POST", "/v1/raises/start", body);
  }
  pow(ticker: string) {
    return this.req<Envelope<PowView>>("GET", `/v1/blokes/${encodeURIComponent(ticker)}/pow`);
  }
  addPow(ticker: string, body: { kind: PowItem["kind"]; title: string; url: string; ref?: string }) {
    return this.req<{ data: PowItem }>("POST", `/v1/blokes/${encodeURIComponent(ticker)}/pow`, body);
  }
  updatePow(id: number, body: { kind: PowItem["kind"]; title: string; url: string; ref?: string }) {
    return this.req<{ data: PowItem }>("PATCH", `/v1/pow/${id}`, body);
  }
  retractPow(id: number) {
    return this.req<{ data: { id: number } }>("DELETE", `/v1/pow/${id}`);
  }
  raises() {
    return this.req<Envelope<RaiseView[]>>("GET", "/v1/raises");
  }
  raise(ticker: string, wallet?: string) {
    return this.req<Envelope<RaiseView | null>>("GET", `/v1/raises/${encodeURIComponent(ticker)}${wallet ? `?wallet=${wallet}` : ""}`);
  }
  archetypes() {
    return this.req<Envelope<ArchetypeView[]>>("GET", "/v1/archetypes");
  }
  bloke(ticker: string) {
    return this.req<Envelope<BlokeDetail>>("GET", `/v1/blokes/${encodeURIComponent(ticker)}`);
  }
  index(ticker: string, opts: { leg?: Leg; range?: "1h" | "24h" | "7d" | "30d" } = {}) {
    const q = new URLSearchParams({ leg: opts.leg ?? "blend", range: opts.range ?? "24h" });
    return this.req<Envelope<IndexPoint[]>>("GET", `/v1/blokes/${encodeURIComponent(ticker)}/index?${q}`);
  }
  signals(ticker: string) {
    return this.req<SignalsEnvelope>("GET", `/v1/blokes/${encodeURIComponent(ticker)}/signals`);
  }
  trades(marketId: number, limit = 50) {
    return this.req<Envelope<Trade[]>>("GET", `/v1/markets/${marketId}/trades?limit=${limit}`);
  }
  pool() {
    return this.req<Envelope<PoolView>>("GET", "/v1/pool");
  }
  epochs(limit = 24) {
    return this.req<Envelope<EpochRow[]>>("GET", `/v1/epochs?limit=${limit}`);
  }
  wallet(address: Address) {
    return this.req<Envelope<WalletView>>("GET", `/v1/wallets/${address}`);
  }
  rep(season = 1, limit = 100) {
    return this.req<Envelope<{ wallet: Address; total: number; rank: number }[]>>("GET", `/v1/rep?season=${season}&limit=${limit}`);
  }
  status() {
    return this.req<Envelope<StatusView>>("GET", "/v1/status");
  }

  // ---------------------------------------------------------------- auth (SIWE, EIP-4361)

  /** Fetches a nonce and the exact message the wallet must sign. */
  siweMessage(address: Address, chainId: number) {
    return this.req<{ nonce: string; message: string }>("POST", "/v1/auth/nonce", { address, chainId });
  }

  /** Verifies the signature, starts a session and remembers the token for later calls. */
  async signIn(message: string, signature: `0x${string}`) {
    const r = await this.req<{ token: string; session: Session }>("POST", "/v1/auth/siwe", { message, signature });
    this.token = r.token;
    return r;
  }
  session() {
    return this.req<{ data: Session }>("GET", "/v1/auth/session");
  }
  signOut() {
    return this.req<{ ok: true }>("POST", "/v1/auth/logout");
  }

  // ---------------------------------------------------------------- identity (OAuth)

  /** URL to send the browser to; the provider redirects back to `redirectUri` with code + state. */
  identityStart(provider: "github" | "x", redirectUri: string) {
    return this.req<{ url: string; state: string }>("POST", `/v1/identity/${provider}/start`, { redirectUri });
  }
  identityCallback(provider: "github" | "x" | "test", body: Record<string, unknown>) {
    return this.req<{ data: Session }>("POST", `/v1/identity/${provider}/callback`, body);
  }

  // ---------------------------------------------------------------- attestations and relays

  /** Mints the faucet amount to the session wallet; the API relays the transaction (gasless). */
  faucet() {
    return this.req<{ data: FaucetResult }>("POST", "/v1/faucet");
  }
  claimAttestation(ticker: string) {
    return this.req<{ data: ClaimAttestation }>("POST", "/v1/claims", { ticker });
  }
  /** Message each deployer address must sign (EIP-191) before `verifySources`. */
  sourcesMessage(ticker: string) {
    return this.req<{ message: string }>("POST", "/v1/sources/message", { ticker });
  }
  verifySources(ticker: string, deployers: { address: Address; signature: `0x${string}` }[]) {
    return this.req<{ data: SourcesAttestation }>("POST", "/v1/sources/verify", { ticker, deployers });
  }
  suggest(handle: string) {
    return this.req<{ data: { handle: string; first: boolean } }>("POST", "/v1/suggestions", { handle });
  }
  report(body: { kind: "abuse" | "removal"; ticker?: string; body: string }) {
    return this.req<{ data: { id: string } }>("POST", "/v1/reports", body);
  }
}
