import type { AppDatabase } from "../db/database.js";

export class ApprovalService {
  constructor(private readonly db: AppDatabase) {}

  request(sessionId: string | undefined, action: string, risk: string, command: string | undefined, requestedBy = "agent") {
    const id = this.db.id("appr");
    this.db.sqlite
      .prepare(
        `INSERT INTO approvals (id, session_id, action, risk, command, state, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, sessionId ?? null, action, risk, command ?? null, requestedBy, this.db.now());
    this.db.event("approval.requested", { approvalId: id, action, risk, command }, requestedBy, undefined, sessionId);
    this.db.event("approval_requested", { approvalId: id, action, risk, command }, requestedBy, undefined, sessionId);
    const row = this.get(id);
    if (!row) {
      throw Object.assign(new Error(`approval ${id} not found after write`), { statusCode: 500, code: "approval_missing_after_write" });
    }
    return row;
  }

  approve(id: string, response = "approved") {
    return this.resolve(id, "approved", response);
  }

  deny(id: string, response = "denied") {
    return this.resolve(id, "denied", response);
  }

  get(id: string) {
    return this.db.sqlite.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  }

  listPending() {
    return this.db.sqlite.prepare("SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at").all();
  }

  private resolve(id: string, state: "approved" | "denied", response: string) {
    const approval = this.get(id) as { session_id?: string; action?: string } | undefined;
    if (!approval) throw Object.assign(new Error(`approval ${id} not found`), { statusCode: 404 });
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE approvals SET state = ?, response = ?, resolved_at = ? WHERE id = ?")
      .run(state, response, now, id);
    this.db.sqlite
      .prepare(
        `INSERT INTO decisions (id, session_id, approval_id, decision, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.id("dec"), approval.session_id ?? null, id, state, response, now);
    this.db.event(`approval.${state}`, { approvalId: id, response }, "user", undefined, approval.session_id);
    this.db.event("approval_result", { approvalId: id, decision: state, response }, "user", undefined, approval.session_id);
    return this.get(id)!;
  }
}
