/**
 * A few pre-minted pixel tokens kept ready, so the send path never waits on the service worker
 * (minting is async, and Gmail's send request is waiting on us).
 */
export class TokenPool {
  private tokens: string[] = [];
  private filling: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly mint: (count: number) => Promise<string[]>,
    private readonly size = 4,
  ) {}

  fill(): Promise<void> {
    const missing = this.size - this.tokens.length;
    if (missing <= 0) return Promise.resolve();
    const gen = this.generation;
    this.filling ??= this.mint(missing)
      .then((tokens) => {
        if (gen === this.generation) this.tokens.push(...tokens);
      })
      .catch((err) => console.debug("[Seen] couldn't mint tokens", err))
      .finally(() => {
        this.filling = null;
      });
    return this.filling;
  }

  /** A token, waiting up to `timeoutMs` for one if the pool is empty. */
  async take(timeoutMs: number): Promise<string | null> {
    if (this.tokens.length === 0) {
      await Promise.race([this.fill(), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    const token = this.tokens.shift() ?? null;
    void this.fill();
    return token;
  }

  /** Drop everything (tokens embed the user id, so they're useless after reconnecting). */
  reset(): void {
    this.generation++;
    this.tokens = [];
    this.filling = null;
  }
}
