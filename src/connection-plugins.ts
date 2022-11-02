import { Connection } from './connection';

declare global {
  const connectionPlugins: Map<string, new () => { init: (conn: Connection) => void }>;
}

/**
 *  variable Used to store plugin names that need initialization on Connection construction.
 */
const connectionPlugins = new Map<string, new () => { init: (conn: Connection) => void }>();

/** Function: addConnectionPlugin
 *  Extends the Connection object with the given plugin.
 *
 *  Parameters:
 *    (String) name - The name of the extension.
 *    (Object) ptype - The plugin's prototype.
 */
export function addConnectionPlugin(name: string, ptype: new () => object): void {
  connectionPlugins[name] = ptype;
}
