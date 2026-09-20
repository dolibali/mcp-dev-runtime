import * as z from 'zod/v4';

// Lightweight configuration only. Importing Config never loads YAML or scans files.
const configuredPath = z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value), 'Invalid path');
export const skillsConfigSchema = z.strictObject({
  extra_roots: z.array(configuredPath).max(32).default([]),
  disabled_paths: z.array(configuredPath).max(256).default([])
});
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;
