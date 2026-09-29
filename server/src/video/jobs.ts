/** Tiny in-memory job registry for long-running generations (Seedance takes run for minutes). */

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  message: string;
  created: number;
  updated: number;
  result?: T;
  error?: string;
}

const jobs = new Map<string, Job>();
const TTL = 3 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.updated > TTL) jobs.delete(id);
}

export function createJob<T>(kind: string, run: (update: (message: string) => void) => Promise<T>): Job<T> {
  sweep();
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: Job<T> = { id, kind, status: 'queued', message: 'Queued', created: Date.now(), updated: Date.now() };
  jobs.set(id, job as Job);
  const update = (message: string) => {
    job.message = message;
    job.updated = Date.now();
  };
  (async () => {
    job.status = 'running';
    update('Starting');
    try {
      job.result = await run(update);
      job.status = 'done';
      update('Done');
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message || String(e);
      update('Failed');
      console.error(`[job ${id}]`, job.error);
    }
  })();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function publicJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    message: job.message,
    elapsed: Math.round((Date.now() - job.created) / 1000),
    result: job.status === 'done' ? job.result : undefined,
    error: job.error,
  };
}
