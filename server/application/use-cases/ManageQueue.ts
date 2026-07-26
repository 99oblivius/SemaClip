import type { JobRepository } from "@/application/ports/outbound.ts";
import type { Job, QueueAction } from "shared/types";

export class ManageQueueUseCase {
  constructor(private readonly jobs: JobRepository) {}

  async execute(action: QueueAction): Promise<Job[]> {
    switch (action.type) {
      case "reorder":
        return this.reorder(action.jobId, action.newPosition ?? 0);
      case "cancel":
        return this.removeFromQueue(action.jobId);
    }
    throw new Error(`Unreachable: unknown action type`);
  }

  private async reorder(jobId: string, newPosition: number): Promise<Job[]> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status !== "queued") throw new Error("Can only reorder queued jobs");

    const queued = await this.jobs.listQueued();
    const filtered = queued.filter((j) => j.id !== jobId);
    filtered.splice(Math.min(newPosition, filtered.length), 0, { ...job, position: newPosition });
    for (let i = 0; i < filtered.length; i++) {
      const j = filtered[i]!;
      if (j.position !== i) {
        await this.jobs.update({ ...j, position: i });
      }
    }
    return this.jobs.listQueued();
  }

  private async removeFromQueue(jobId: string): Promise<Job[]> {
    await this.jobs.delete(jobId);
    return this.jobs.listQueued();
  }
}
