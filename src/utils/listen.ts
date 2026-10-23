import type { Server } from "node:http";
import type { Express } from "express";

export async function listen(
  app: Express,
  port = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const created = app.listen(port, "127.0.0.1");
    created.once("listening", () => resolve(created));
    created.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
