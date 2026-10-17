type GuardState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
};

export class AuthKeyCompatGuard {
  constructor(private readonly state: GuardState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/claim") return new Response(null, { status: 404 });
    const claimed = await this.state.storage.get<boolean>("claimed");
    if (claimed) return Response.json({ claimed: false }, { status: 409 });
    await this.state.storage.put("claimed", true);
    return Response.json({ claimed: true });
  }
}
