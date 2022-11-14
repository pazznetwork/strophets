import { Connection } from './connection';

declare global {
  interface Window {
    connectionPlugins: Map<string, new () => { init: (conn: Connection) => void }>;
  }
}

/**
 *  variable Used to store plugin names that need initialization on Connection construction.
 */
export const connectionPlugins = (window.connectionPlugins = new Map<
  string,
  new () => { init: (conn: Connection) => void }
>());

/** Function: addConnectionPlugin
 *  Extends the Connection object with the given plugin.
 *
 *  Parameters:
 *    (String) name - The name of the extension.
 *    (Object) ptype - The plugin's prototype.
 */
export function addConnectionPlugin(name: string, ptype: new () => object): void {
  window.connectionPlugins[name] = ptype;
}

export {};
