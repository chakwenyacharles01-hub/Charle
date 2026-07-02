const { RouterOSClient } = require('routeros-client');
require('dotenv').config();

function getClient() {
  return new RouterOSClient({
    host: process.env.MIKROTIK_HOST,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASSWORD,
    port: Number(process.env.MIKROTIK_PORT) || 8728,
    tls: process.env.MIKROTIK_USE_TLS === 'true'
  });
}

/**
 * Creates a hotspot user on the router with a time limit.
 * username/password are usually the same (the voucher code).
 */
async function createHotspotUser({ username, password, profile, limitUptime, dataCapMb }) {
  const client = getClient();
  const api = await client.connect();
  try {
    const menu = api.menu('/ip/hotspot/user');
    const params = {
      name: username,
      password: password,
      profile: profile || 'default',
      server: process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
      'limit-uptime': limitUptime // e.g. '01:00:00' for 1 hour
    };
    if (dataCapMb) {
      // limit-bytes-total is in bytes
      params['limit-bytes-total'] = String(dataCapMb * 1024 * 1024);
    }
    await menu.add(params);
    return { success: true };
  } finally {
    client.close();
  }
}

async function removeHotspotUser(username) {
  const client = getClient();
  const api = await client.connect();
  try {
    const menu = api.menu('/ip/hotspot/user');
    const existing = await menu.where({ name: username }).get();
    for (const item of existing) {
      await menu.remove(item['.id']);
    }
    return { success: true };
  } finally {
    client.close();
  }
}

async function getActiveUsers() {
  const client = getClient();
  const api = await client.connect();
  try {
    const menu = api.menu('/ip/hotspot/active');
    const active = await menu.get();
    return active;
  } finally {
    client.close();
  }
}

async function disconnectUser(username) {
  const client = getClient();
  const api = await client.connect();
  try {
    const menu = api.menu('/ip/hotspot/active');
    const active = await menu.where({ user: username }).get();
    for (const item of active) {
      await menu.remove(item['.id']);
    }
    return { success: true };
  } finally {
    client.close();
  }
}

async function testConnection() {
  const client = getClient();
  try {
    const api = await client.connect();
    const identity = await api.menu('/system/identity').get();
    client.close();
    return { success: true, identity };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  createHotspotUser,
  removeHotspotUser,
  getActiveUsers,
  disconnectUser,
  testConnection
};
