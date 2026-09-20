import * as z from 'zod/v4';
const workdir = z.string().min(1).max(4096);
export const discoverArgs = z.strictObject({
  workdir,
  query: z.string().trim().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(20).default(5),
  cursor: z.string().min(1).max(2048).optional(),
  refresh: z.boolean().default(false)
});
export const readArgs = z.strictObject({
  workdir,
  skill: z.string().min(1).max(512),
  resource: z.string().min(1).max(2048).default('SKILL.md'),
  cursor: z.string().min(1).max(2048).optional(),
  explicit: z.boolean().default(false)
});
