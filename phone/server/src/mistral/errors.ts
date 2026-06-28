export class MistralConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MistralConfigError";
  }
}

export class MistralApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "MistralApiError";
  }
}

export function isTemporaryMistralStatus(status: number) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}
