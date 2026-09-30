export class WtcError extends Error {
  constructor(public code: string, message: string, public hint?: string) {
    super(message);
    this.name = "WtcError";
  }
}
