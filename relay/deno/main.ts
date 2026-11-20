// Deno Deploy entry: project "super-player-relay" (.github/workflows/relay-deno.yml).
// Routes and rules: ./relay.ts.  Local: deno run --allow-net --allow-env relay/deno/main.ts
import { makeHandler } from "./relay.ts";

Deno.serve({ port: Number(Deno.env.get("PORT") || 8000) }, makeHandler());
