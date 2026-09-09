export class RenderError extends Error {
  constructor(
    message: string,
    readonly kind: "filesystem" | "rendering",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RenderError";
  }
}
