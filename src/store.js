/**
 * 名册存储门面：默认 JSON 文件；配置 DATABASE_URL / STORE_DRIVER=postgres 时走 PG。
 */

import { getStoreDriver } from './config.js';

/** @type {any} */
let backend = null;

/** 启动时调用一次：选驱动并建表（PG）。 */
export async function initStore() {
  const driver = getStoreDriver();
  if (driver === 'postgres') {
    backend = await import('./store-pg.js');
  } else {
    backend = await import('./store-file.js');
  }
  await backend.init();
  return driver;
}

function api() {
  if (!backend) throw new Error('存储尚未初始化，请先 await initStore()');
  return backend;
}

/** @param {any} m */
export function toPublicMember(m) {
  return api().toPublicMember(m);
}

export async function listMembers() {
  return api().listMembers();
}

/** @param {{ displayName: string, sessionToken: string }} input */
export async function addMember(input) {
  return api().addMember(input);
}

/**
 * @param {string} id
 * @param {{ displayName?: string, sessionToken?: string }} patch
 */
export async function updateMember(id, patch) {
  return api().updateMember(id, patch);
}

/**
 * @param {{ displayName?: string, sessionToken: string, email?: string }} input
 */
export async function upsertMemberBySession(input) {
  return api().upsertMemberBySession(input);
}

/** @param {string} id */
export async function deleteMember(id) {
  return api().deleteMember(id);
}

/** @param {string} id */
export async function getMemberInternal(id) {
  return api().getMemberInternal(id);
}

export async function getAllMembersInternal() {
  return api().getAllMembersInternal();
}

/**
 * @param {string} id
 * @param {{ snapshot?: object | null, error?: string | null }} result
 */
export async function saveSyncResult(id, result) {
  return api().saveSyncResult(id, result);
}
