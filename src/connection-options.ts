/**
 * Options for the Strophe Connection
 *  shared options between WebSocket and BOSH are:
 *   - cookies
 *   - mechanisms (for SASL)
 *   - explicitResourceBinding (to have additional step for connections setups)
 *  WebSocket only:
 *   - protocol (upgrade current protocol to ws or wss)
 *   - worker (url to load the worker script from, for example for shared sessions)
 *  BOSH only:
 *   - sync (make requests synchronous)
 *   - customHeaders (add custom headers to requests)
 *   - keepalive (store session data for reconnections)
 *   - withCredentials (if you need to add auth cookies to ajax requests)
 *   - contentType (default is "text/xml; charset=utf-8")
 */
import { BoshOptions } from './bosh-options';
import { WebsocketOptions } from './websocket-options';

export interface ConnectionOptions extends BoshOptions, WebsocketOptions {}
