import { SASLMechanism } from './sasl-mechanism';

export interface WebsocketOptions {
  /**
   * cookies - Common option for Websocket and Bosh:
   *  The *cookies* option allows you to pass in cookies to be added to the
   *  document. These cookies will then be included in the BOSH XMLHttpRequest
   *  or in the websocket connection.
   *
   *  The passed in value must be a map of cookie names and string values.
   *
   *  > { "myCookie": {
   *  >     "value": "1234",
   *  >     "domain": ".example.org",
   *  >     "path": "/",
   *  >     "expires": expirationDate
   *  >     }
   *  > }
   *
   *  Note that cookies can't be set in this way for other domains (i.e. cross-domain).
   *  Those cookies need to be set under those domains, for example they can be
   *  set server-side by making a XHR call to that domain to ask it to set any
   *  necessary cookies.
   */
  cookies?: Record<string, Record<string, string>>;
  /**
   * mechanisms - Common option for Websocket and Bosh:
   *  The *mechanisms* option allows you to specify the SASL mechanisms that this
   *  instance of Strophe.Connection (and therefore your XMPP client) will
   *  support.
   *
   *  The value must be an array of objects with Strophe.SASLMechanism
   *  prototypes.
   *
   *  If nothing is specified, then the following mechanisms (and their
   *  priorities) are registered:
   *
   *      SCRAM-SHA-1 - 60
   *      PLAIN       - 50
   *      OAUTHBEARER - 40
   *      X-OAUTH2    - 30
   *      ANONYMOUS   - 20
   *      EXTERNAL    - 10
   */
  mechanisms?: SASLMechanism[];
  /**
   * explicitResourceBinding - Common option for Websocket and Bosh:
   *  If `explicitResourceBinding` is set to a truthy value, then the XMPP client
   *  needs to explicitly call `Strophe.Connection.prototype.bind` once the XMPP
   *  server has advertised the "urn:ietf:params:xml:ns:xmpp-bind" feature.
   *
   *  Making this step explicit allows client authors to first finish other
   *  stream related tasks, such as setting up an XEP-0198 Stream Management
   *  session, before binding the JID resource for this session.
   */
  explicitResourceBinding?: boolean;
  /**
   * protocol - WebSocket option:
   *  If you want to connect to the current host with a WebSocket connection you
   *  can tell Strophe to use WebSockets through a "protocol" attribute in the
   *  optional option's parameter. Valid values are "ws" for WebSocket and "wss"
   *  for Secure WebSocket.
   *  So to connect to "wss://CURRENT_HOSTNAME/xmpp-websocket" you would call
   *
   *  > const conn = new Strophe.Connection("/xmpp-websocket/", {protocol: "wss"});
   *
   *  Note that relative URLs _NOT_ starting with a "/" will also include the path
   *  of the current site.
   *
   *  Also, because downgrading security is not permitted by browsers, when using
   *  relative URLs both BOSH and WebSocket connections will use their secure
   *  variants if the current connection to the site is also secure (https).
   */
  protocol?: string;
}
