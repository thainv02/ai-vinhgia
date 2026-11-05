/** Shared by API views and web; accepts only the state needed to decide whether a job is active. */
export const jobIsActive = (job: { status: string } | null | undefined): boolean =>
  !!job && (job.status === 'queued' || job.status === 'claimed' || job.status === 'running');
