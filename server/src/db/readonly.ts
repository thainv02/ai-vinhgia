import Database from 'better-sqlite3';

/** Used by local CLI helpers without running migrations or taking ownership of live DB. */
export const readOnlyDb = (file: string) => new Database(file, { readonly: true, fileMustExist: true });
