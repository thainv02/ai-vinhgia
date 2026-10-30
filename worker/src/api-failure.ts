export class ApiFailure extends Error {
  constructor(public code: string, message: string, public details?: { retry_at?: string }) { super(message); }
}
