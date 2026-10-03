declare const validate: ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string; keyword: string; params: Record<string, unknown> }> | null };
export default validate;
