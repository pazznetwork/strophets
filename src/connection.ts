import { SASLMechanism } from './sasl';
import { Handler } from './handler';
import { TimedHandler } from './timed-handler';
import { Status } from './status';
import { Builder } from './builder';
import { addCookies } from './utils';
import { NS } from './namespace';
import { forEachChild, getBareJidFromJid, getDomainFromJid, getNodeFromJid, getResourceFromJid, getText } from './xml';
import { ErrorCondition, handleError } from './error';
import { $build, $iq, $pres } from './builder-helper';
import { debug, info, log, LogLevel, warn } from './log';
import { Bosh } from './bosh';
import { Request } from './request';
import { WorkerWebsocket } from './worker-websocket';
import { StropheWebsocket } from './websocket';
import { PromiseWrapper } from './promise-wrapper';
import { SASLExternal } from './sasl-external';
import { SASLAnonymous } from './sasl-anon';
import { SASLOAuthBearer } from './sasl-oauthbearer';
import { SASLXOAuth2 } from './sasl-xoauth2';
import { SASLPlain } from './sasl-plain';
import { SASLSHA1 } from './sasl-sha1';
import { SASLSHA256 } from './sasl-sha256';
import { SASLSHA384 } from './sasl-sha384';
import { SASLSHA512 } from './sasl-sha512';
import { ProtocolManager } from './protocol-manager';
import { debounceTime, filter, firstValueFrom, from as fromRxjs, Observable, share, shareReplay, startWith, Subject } from 'rxjs';
import { Matcher, MatcherConfig } from './matcher';
import { ConnectionOptions } from './connection-options';
import { AuthenticationMode } from './authentication-mode';
import { getOpenPromise } from './get-open-promise';
import { Credentials } from './credentials';
import { errorMessages } from './error-messages';
import { HandlerAsync } from './handlerAsync';

/**
 *  XMPP Connection manager.
 *
 *  This class is the main part of Strophe.  It manages a BOSH connection
 *  to an XMPP server and dispatches events to the user callbacks as
 *  data arrives.  It supports SASL PLAIN, SASL DIGEST-MD5, SASL SCRAM-SHA1
 *  and legacy authentication.
 *
 *  After creating a Strophe.Connection object, the user will typically
 *  call connect() with a user supplied callback to handle connection level
 *  events like authentication failure, disconnection, or connection
 *  complete.
 *
 *  The user will also have several event handlers defined by using
 *  addHandler() and addTimedHandler().  These will allow the user code to
 *  respond to interesting stanzas or do something periodically with the
 *  connection.  These handlers will be active once authentication is
 *  finished.
 *
 *  To send data to the connection, use send().
 */
export class Connection {
  /**
   * variable that keeps track of the request ids for connections.
   */
  private static requestId = 0;

  /**
   * The connected JID.
   */
  jid = '';

  private readonly userJidSubject = new Subject<string>();
  private readonly willReconnectSubject = new Subject<void>();

  userJid$: Observable<string> = this.userJidSubject.pipe(share());
  willReconnect$: Observable<void> = this.willReconnectSubject.pipe(share());

  /**
   * The domain of the connected JID.
   */
  domain: string = null;
  features: Element;

  // SASL
  do_bind: boolean;
  do_session: boolean;
  mechanism: Record<string, SASLMechanism>;

  // handler lists
  timedHandlers: TimedHandler[];
  handlers: Handler[];
  removeTimeds: TimedHandler[];
  removeHandlers: Handler[];
  removeHandlersAsync: HandlerAsync[];
  addTimeds: TimedHandler[];
  addHandlers: Handler[];
  addHandlersAsync: HandlerAsync[];
  protocolErrorHandlers: {
    HTTP: Record<number, (status: number) => unknown>;
    websocket: Record<number, (status: number) => unknown>;
  };

  authenticated: boolean;
  connected: boolean;
  disconnecting: boolean;
  do_authentication: boolean;
  paused: boolean;
  restored: boolean;

  maxRetries: number;

  status: Status;

  /** Variable: authzid
   *  Set on connection.
   *  Authorization identity.
   */
  authzid: string;
  /** Variable: authcid
   *  Set on connection.
   *  Authentication identity (Username).
   */
  authcid: string;
  /** Variable: pass
   *  Set on connection.
   *  Authentication identity (User password).
   */
  pass: string | { name: string; salt: string; iter: number; ck: string; sk: string };
  /** parameter: callback
   *  Set on connection.
   *  Callback after connecting.
   */
  connect_callback: (status: number, condition: string, elem: Element) => unknown;

  disconnection_timeout: number;

  private stanzasInSubject = new Subject<Element>();
  stanzasIn$ = this.stanzasInSubject.pipe(share());
  private stanzasOutSubject = new Subject<Element>();
  stanzasOut$ = this.stanzasOutSubject.pipe(share());

  protected readonly stateSubject = new Subject<Status>();
  readonly state$ = this.stateSubject.pipe(startWith(Status.DISCONNECTED), shareReplay(1));

  private afterResourceBindingSubject = new Subject<void>();
  private reconnectedSubject = new Subject<void>();
  private connectedSubject = new Subject<void>();
  private disconnectedSubject = new Subject<void>();

  private reconnecting = false;

  private connectionStatus: { status: Status; message: string };

  private session: Record<string, unknown>;
  private bareJid: string;
  private domainJid: string;

  private disconnectionCause: Status;
  private disconnectionReason: string;
  private sendInitialPresence: boolean;

  /**
   * protocol used for connection
   */
  protocolManager: ProtocolManager;

  workerPromise?: PromiseWrapper<unknown>;
  saslData: Record<string, unknown>;
  private mechanisms: SASLMechanism[];
  idleTimeout: number;
  private disconnectTimeout: TimedHandler;
  data: Element[];
  private uniqueId: number;
  private saslSuccessHandler: Handler;
  private saslFailureHandler: Handler;
  private saslChallengeHandler: HandlerAsync;
  private scramKeys: unknown;
  private iqFallbackHandler: Handler;
  private saslMechanism: SASLMechanism;

  private readonly CONNECTION_STATUS = {
    [Status.ATTACHED]: 'ATTACHED',
    [Status.AUTHENTICATING]: 'AUTHENTICATING',
    [Status.AUTHFAIL]: 'AUTHFAIL',
    [Status.CONNECTED]: 'CONNECTED',
    [Status.CONNECTING]: 'CONNECTING',
    [Status.CONNFAIL]: 'CONNFAIL',
    [Status.DISCONNECTED]: 'DISCONNECTED',
    [Status.DISCONNECTING]: 'DISCONNECTING',
    [Status.ERROR]: 'ERROR',
    [Status.RECONNECTING]: 'RECONNECTING',
    [Status.REDIRECT]: 'REDIRECT'
  };

  get handlePreBind(): boolean {
    return this.authenticationMode === AuthenticationMode.PREBIND && !!this.prebindUrl;
  }

  /**
   * Stores the passed in JID for the current user, potentially creating a
   * resource if the JID is bare.
   *
   * @emits userJidSubject
   * @param {string} jid
   */
  setUserJID(jid: string): string {
    /**
     * Triggered whenever the user's JID has been updated
     */
    this.jid = jid;
    this.userJidSubject.next(this.jid);
    return this.jid;
  }

  /**
   *  Create and initialize a Strophe.Connection object.
   *
   *  The transport-protocol for this connection will be chosen automatically
   *  based on the given service parameter. URLs starting with "ws://" or
   *  "wss://" will use WebSockets, URLs starting with "http://", "https://"
   *  or without a protocol will use BOSH.
   *
   *  To make Strophe connect to the current host you can leave out the protocol
   *  and host part and just pass the path, e.g.
   *
   *  > const conn = new Connection("/http-bind/");
   *
   *  Parameters:
   *
   *    @param service - The BOSH or WebSocket service URL.
   *    @param options - A hash of configuration options
   *    @param authenticationMode
   *    @param prebindUrl
   *    @param boshServiceUrl
   *    @param websocketUrl
   *    @param credentialsUrl
   *    @param password
   *
   */
  private constructor(
    public service: string,
    readonly options?: ConnectionOptions,
    readonly authenticationMode?: AuthenticationMode,
    readonly prebindUrl?: string,
    readonly boshServiceUrl?: string,
    readonly websocketUrl?: string,
    readonly credentialsUrl?: string,
    readonly password?: string
  ) {
    this.setProtocol();
    /* stream:features */
    this.features = null;

    // SASL
    this.saslData = {};
    this.do_bind = false;
    this.do_session = false;
    this.mechanisms = [];

    // handler lists
    this.timedHandlers = [];
    this.handlers = [];
    this.removeTimeds = [];
    this.removeHandlers = [];
    this.addTimeds = [];
    this.addHandlers = [];
    this.protocolErrorHandlers = {
      HTTP: {},
      websocket: {}
    };

    this.idleTimeout = null;
    this.disconnectTimeout = null;

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;
    this.do_authentication = true;
    this.paused = false;
    this.restored = false;

    this.data = [];
    this.uniqueId = 0;

    this.saslSuccessHandler = null;
    this.saslFailureHandler = null;
    this.saslChallengeHandler = null;

    // Max retries before disconnecting
    this.maxRetries = 5;

    // Call onIdle callback every 1/10th of a second
    // @ts-ignore
    this.idleTimeout = setTimeout(() => this._onIdle(), 100);

    addCookies(this.options.cookies);
    this.registerSASLMechanisms(this.options.mechanisms);

    // A client must always respond to incoming IQ "set" and "get" stanzas.
    // See https://datatracker.ietf.org/doc/html/rfc6120#section-8.2.3
    //
    // This is a fallback handler which gets called when no other handler
    // was called for a received IQ "set" or "get".
    this.iqFallbackHandler = new Handler(
      (iq) => {
        this.send(
          $iq({ type: 'error', id: iq.getAttribute('id') })
            .c('error', { type: 'cancel' })
            .c('service-unavailable', { xmlns: NS.STANZAS })
        );
        return false;
      },
      null,
      'iq',
      ['get', 'set']
    );

    // initialize plugins
    for (const [key, value] of connectionPlugins.entries()) {
      const plugin = new value();
      plugin.init(this);
      this[key] = plugin;
    }
  }

  /**
   *  Select protocol based on this.options or this.service
   */
  setProtocol(): void {
    const proto = this.options.protocol || '';
    if (this.options.worker) {
      this.protocolManager = new WorkerWebsocket(this, this.stanzasInSubject);
    } else if (this.service.indexOf('ws:') === 0 || this.service.indexOf('wss:') === 0 || proto.indexOf('ws') === 0) {
      this.protocolManager = new StropheWebsocket(this, this.stanzasInSubject);
    } else {
      this.protocolManager = new Bosh(this, this.prebindUrl);
    }
  }

  /**
   *  Reset the connection.
   *
   *  This function should be called after a connection is disconnected
   *  before that connection is reused.
   */
  reset(): void {
    this.protocolManager.reset();

    // SASL
    this.do_session = false;
    this.do_bind = false;

    // handler lists
    this.timedHandlers = [];
    this.handlers = [];
    this.removeTimeds = [];
    this.removeHandlers = [];
    this.addTimeds = [];
    this.addHandlers = [];

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;
    this.restored = false;

    this.data = [];
    this.uniqueId = 0;
  }

  /**
   *  Pause the request manager.
   *
   *  This will prevent Strophe from sending any more requests to the
   *  server.  This is very useful for temporarily pausing
   *  BOSH-Connections while a lot of send() calls are happening quickly.
   *  This causes Strophe to send the data in a single request, saving
   *  many request trips.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   *  Resume the request manager.
   *
   *  This resumes after pause() has been called.
   */
  resume(): void {
    this.paused = false;
  }

  /**
   *  Generate a unique ID for use in <iq/> elements.
   *
   *  All <iq/> stanzas are required to have unique id attributes.  This
   *  function makes creating these easy.  Each connection instance has
   *  a counter which starts from zero, and the value of this counter
   *  plus a colon followed by the suffix becomes the unique id. If no
   *  suffix is supplied, the counter is used as the unique id.
   *
   *  Suffixes are used to make debugging easier when reading the stream
   *  data, and their use is recommended.  The counter resets to 0 for
   *  every new connection for the same reason.  For connections to the
   *  same server that authenticate the same way, all the ids should be
   *  the same, which makes it easy to see changes.  This is useful for
   *  automated testing as well.
   *
   *  Parameters:
   *
   *    @param suffix - A optional suffix to append to the id.
   *
   *  Returns:
   *    @returns A unique string to be used for the id attribute.
   */
  getUniqueId(suffix?: string | number): string {
    const uuid: string = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0,
        v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    if (suffix != null) {
      return uuid + ':' + suffix;
    }

    return uuid;
  }

  /**
   *  Register a handler function for when a protocol (websocker or HTTP)
   *  error occurs.
   *
   *  NOTE: Currently only HTTP errors for BOSH requests are handled.
   *  Patches that handle websocket errors would be very welcome.
   *
   *  Parameters:
   *
   *    @param protocol - 'HTTP' or 'websocket'
   *    @param status_code - Error status code (e.g 500, 400 or 404)
   *    @param callback - Function that will fire on Http error
   *
   *  Example:
   *  function onError(err_code){
   *    //do stuff
   *  }
   *
   *  let conn = connect('http://example.com/http-bind');
   *  conn.addProtocolErrorHandler('HTTP', 500, onError);
   *  // Triggers HTTP 500 error and onError handler will be called
   *  conn.connect('user_jid@incorrect_jabber_host', 'secret', onConnect);
   */
  addProtocolErrorHandler(protocol: string, status_code: number, callback: (status: number) => unknown): void {
    this.protocolErrorHandlers[protocol][status_code] = callback;
  }

  /**
   *  Starts the connection process.
   *
   *  As the connection process proceeds, the user supplied callback will
   *  be triggered multiple times with status updates.  The callback
   *  should take two arguments - the status code and the error condition.
   *
   *  The status code will be one of the values in the Status
   *  constants.  The error condition will be one of the conditions
   *  defined in RFC 3920 or the condition 'strophe-parsererror'.
   *
   *  The Parameters _wait_, _hold_ and _route_ are optional and only relevant
   *  for BOSH connections. Please see XEP 124 for a more detailed explanation
   *  of the optional parameters.
   *
   *  Parameters:
   *
   *    @param jid - The user's JID.  This may be a bare JID,
   *      or a full JID.  If a node is not supplied, SASL ANONYMOUS
   *      authentication will be attempted.
   *    @param pass - The user's password.
   *    @param callback - The connect callback function.
   *    @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *    @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    @param route - The optional route value.
   *    @param authcid - The optional alternative authentication identity
   *      (username) if intending to impersonate another user.
   *      When using the SASL-EXTERNAL authentication mechanism, for example
   *      with client certificates, then the authcid value is used to
   *      determine whether an authorization JID (authzid) should be sent to
   *      the server. The authzid should NOT be sent to the server if the
   *      authzid and authcid are the same. So to prevent it from being sent
   *      (for example when the JID is already contained in the client
   *      certificate), set authcid to that same JID. See XEP-178 for more
   *      details.
   *    @param [disconnection_timeout=3000] - The optional disconnection timeout
   *      in milliseconds before _doDisconnect will be called.
   */
  connect(
    jid?: string,
    pass?: string,
    callback?: (status: Status, condition: string, elem: Element) => unknown,
    wait = 59,
    hold?: number,
    route?: string,
    authcid?: string,
    disconnection_timeout?: number
  ): void {
    if (!this.boshServiceUrl && !this.websocketUrl) {
      throw new Error('You must supply a value for either the bosh_service_url or websocket_url or both.');
    }

    this.jid = jid;
    /** Variable: authzid
     *  Authorization identity.
     */
    this.authzid = getBareJidFromJid(this.jid);

    /** Variable: authcid
     *  Authentication identity (User name).
     */
    this.authcid = authcid || getNodeFromJid(this.jid);

    /** Variable: pass
     *  Authentication identity (User password).
     *
     */
    this.pass = pass;

    /** Variable: scramKeys
     *  The SASL SCRAM client and server keys. This variable will be populated with a non-null
     *  object of the above described form after a successful SCRAM connection
     *
     */
    this.scramKeys = null;

    this.connect_callback = callback;
    this.disconnecting = false;
    this.connected = false;
    this.authenticated = false;
    this.restored = false;
    this.disconnection_timeout = disconnection_timeout;

    // parse jid for domain
    this.domain = getDomainFromJid(this.jid);

    this.changeConnectStatus(Status.CONNECTING, null);

    this.protocolManager._connect(wait, hold, route);
  }

  /**
   *  Attach to an already created and authenticated BOSH session.
   *
   *  This function is provided to allow Strophe to attach to BOSH
   *  sessions which have been created externally, perhaps by a Web
   *  application.  This is often used to support auto-login type features
   *  without putting user credentials into the page.
   *
   *  Parameters:
   *
   *    @param jid - The full JID that is bound by the session.
   *    @param sid - The SID of the BOSH session.
   *    @param rid - The current RID of the BOSH session.  This RID
   *      will be used by the next request.
   *    @param callback The connect callback function.
   *    @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *      Other settings will require tweaks to the TIMEOUT value.
   *    @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    @param wind - The optional HTTBIND window value.  This is the
   *      allowed range of request ids that are valid.  The default is 5.
   */
  attach(
    jid: string,
    sid: string,
    rid: string,
    callback?: (status: Status, condition: string, elem: Element) => unknown,
    wait?: number,
    hold?: number,
    wind?: number
  ): void {
    // @ts-ignore
    if (this.protocolManager._attach) {
      // @ts-ignore
      return this.protocolManager._attach(jid, sid, rid, callback, wait, hold, wind);
    } else {
      const stropheError = new Error('The "attach" method is not available for your connection protocol');
      stropheError.name = 'StropheSessionError';
      throw stropheError;
    }
  }

  /**
   *
   * Attempt to restore a cached BOSH session.
   *
   * This function is only useful in conjunction with providing the
   * “keepalive”:true option when instantiating a new Connection.
   * When “keepalive” is set to true, Strophe will cache the BOSH tokens
   * RID (Request ID) and SID (Session ID) and then when this function is called,
   * it will attempt to restore the session from those cached tokens.
   * This function must therefore be called instead of connect or attach.
   * For an example on how to use it, please see examples/restore.js
   *
   * Parameters:
   *
   *    @param jid - The user’s JID.  This may be a bare JID or a full JID.
   *    @param callback - connect callback function.
   *    @param wait - The optional HTTPBIND wait value.
   *      This is the time the server will wait before returning an empty result for a request.
   *      The default setting of 60 seconds is recommended.
   *    @param hold - The optional HTTPBIND hold value.
   *      This is the number of connections the server will hold at one time.
   *      This should almost always be set to 1 (the default).
   *    @param [wind=5] wind - The optional HTTBIND window value.
   *      This is the allowed range of request ids that are valid.
   */
  restore(
    jid?: string,
    callback?: (status: Status, condition: string, elem: Element) => unknown,
    wait?: number,
    hold?: number,
    wind?: number
  ): void {
    if (this.protocolManager instanceof Bosh) {
      this.protocolManager._restore(jid, callback, wait, hold, wind);
    } else {
      const stropheError = new Error('The "restore" method can only be used with a BOSH connection.');
      stropheError.name = 'StropheSessionError';
      throw stropheError;
    }
  }

  /**
   *  User overrideable function that receives XML data coming into the
   *  connection.
   *
   *  The default function does nothing.  User code can override this with
   *  > Connection.xmlInput = function (elem) {
   *  >   (user code)
   *  > };
   *
   *  Due to limitations of current Browsers' XML-Parsers the opening and closing
   *  <stream> tag for WebSocket-Connoctions will be passed as selfclosing here.
   *
   *  BOSH-Connections will have all stanzas wrapped in a <body> tag. See
   *  <Bosh.strip> if you want to strip this tag.
   *
   *  Parameters:
   *
   *    @param _elem - XML data received by the connection.
   */
  xmlInput(_elem: Element): void {
    return;
  }

  /**
   *  User overrideable function that receives XML data sent to the
   *  connection.
   *
   *  The default function does nothing.  User code can override this with
   *  > Connection.xmlOutput = function (elem) {
   *  >   (user code)
   *  > };
   *
   *  Due to limitations of current Browsers' XML-Parsers the opening and closing
   *  <stream> tag for WebSocket-Connoctions will be passed as selfclosing here.
   *
   *  BOSH-Connections will have all stanzas wrapped in a <body> tag. See
   *  <Bosh.strip> if you want to strip this tag.
   *
   *  Parameters:
   *
   *    @param _elem - XML data sent by the connection.
   */
  xmlOutput(_elem: Element): void {
    return;
  }

  /**
   *  User overrideable function that receives the new valid rid.
   *
   *  The default function does nothing. User code can override this with
   *  > Connection.nextValidRid = function (rid) {
   *  >    (user code)
   *  > };
   *
   *  Parameters:
   *
   *    @param  _rid - The next valid rid
   */
  nextValidRid(_rid: number): void {
    return;
  }

  /**
   *  Send a stanza.
   *
   *  This function is called to push data onto the send queue to
   *  go out over the wire.  Whenever a request is sent to the BOSH
   *  server, all pending data is sent and the queue is flushed.
   *
   *  Parameters:
   *
   *  @param elem - The stanza to send.
   */
  send(elem: Element | Element[] | Builder): void {
    if (!elem) {
      return;
    }
    if (Array.isArray(elem)) {
      for (const el of elem) {
        this._queueData(el);
      }
    } else if (!(elem instanceof Element)) {
      this._queueData(elem.tree());
    } else {
      this._queueData(elem);
    }
    this.protocolManager._send();
  }

  /**
   *  Immediately send any pending outgoing data.
   *
   *  Normally send() queues outgoing data until the next idle period
   *  (100ms), which optimizes network use in the common cases when
   *  several send()s are called in succession. flush() can be used to
   *  immediately send all pending data.
   */
  flush(): void {
    // cancel the pending idle period and run the idle function
    // immediately
    clearTimeout(this.idleTimeout);
    this._onIdle();
  }

  /**
   *  Helper function to send presence stanzas. The main benefit is for
   *  sending presence stanzas for which you expect a responding presence
   *  stanza with the same id (for example when leaving a chat room).
   *
   *  Parameters:
   *
   *    @param el - The stanza to send.
   *    @param callback - The callback function for a successful request.
   *    @param errback - The callback function for a failed or timed
   *      out request.  On timeout, the stanza will be null.
   *    @param timeout - The time specified in milliseconds for a
   *      timeout to occur.
   *
   *  Returns:
   *    @returns The id used to send the presence.
   */
  sendPresence(
    el: Element | Builder,
    callback?: (elem: Element) => unknown,
    errback?: (elem: Element) => unknown,
    timeout?: number
  ): string {
    let timeoutHandler: TimedHandler = null;
    const elem = el instanceof Element ? el : el.tree();

    let id = elem.getAttribute('id');
    if (!id) {
      // inject id if not found
      id = this.getUniqueId('sendPresence');
      elem.setAttribute('id', id);
    }

    if (typeof callback === 'function' || typeof errback === 'function') {
      const handler = this.addHandler(
        (stanza) => {
          // remove timeout handler if there is one
          if (timeoutHandler) {
            this.deleteTimedHandler(timeoutHandler);
          }
          if (stanza.getAttribute('type') === 'error') {
            if (errback) {
              errback(stanza);
            }
          } else if (callback) {
            callback(stanza);
          }
          return false;
        },
        null,
        'presence',
        null,
        id
      );

      // if timeout specified, set up a timeout handler.
      if (timeout) {
        timeoutHandler = this.addTimedHandler(timeout, () => {
          // get rid of normal handler
          this.deleteHandler(handler);
          // call errback on timeout with null stanza
          if (errback) {
            errback(null);
          }
          return false;
        });
      }
    }
    this.send(elem);
    return id;
  }

  /**
   *  Helper function to send IQ stanzas.
   *
   *  Parameters:
   *
   *    @param el - T XMLElement ashe stanza to send.
   *    @param callback - The callback function for a successful request.
   *    @param errback - The callback function for a failed or timed
   *      out request.  On timeout, the stanza will be null.
   *    @param timeout - The time specified in milliseconds for a
   *      timeout to occur.
   *
   *  Returns:
   *    @returns The id used to send the IQ.
   */
  sendIQ(el: Element | Builder, callback?: (stanza: Element) => unknown, errback?: (stanza: Element) => unknown, timeout?: number): string {
    let timeoutHandler: TimedHandler = null;
    const elem = el instanceof Element ? el : el.tree();

    let id = elem.getAttribute('id');
    if (!id) {
      // inject id if not found
      id = this.getUniqueId('sendIQ');
      elem.setAttribute('id', id);
    }

    if (typeof callback === 'function' || typeof errback === 'function') {
      const handler = this.addHandler(
        (stanza) => {
          // remove timeout handler if there is one
          if (timeoutHandler) {
            this.deleteTimedHandler(timeoutHandler);
          }
          const iqtype = stanza.getAttribute('type');
          if (iqtype === 'result') {
            if (callback) {
              callback(stanza);
            }
          } else if (iqtype === 'error') {
            if (errback) {
              errback(stanza);
            }
          } else {
            const stropheError = new Error(`Got bad IQ type of ${iqtype}`);
            stropheError.name = 'StropheError';
            throw stropheError;
          }
          return false;
        },
        null,
        'iq',
        ['error', 'result'],
        id
      );

      // if timeout specified, set up a timeout handler.
      if (timeout) {
        timeoutHandler = this.addTimedHandler(timeout, () => {
          // get rid of normal handler
          this.deleteHandler(handler);
          // call errback on timeout with null stanza
          if (errback) {
            errback(null);
          }
          return false;
        });
      }
    }
    this.send(elem);
    return id;
  }

  /**
   *  Add a timed handler to the connection.
   *
   *  This function adds a timed handler.  The provided handler will
   *  be called every period milliseconds until it returns false,
   *  the connection is terminated, or the handler is removed.  Handlers
   *  that wish to continue being invoked should return true.
   *
   *  Because of method binding it is necessary to save the result of
   *  this function if you wish to remove a handler with
   *  deleteTimedHandler().
   *
   *  Note that user handlers are not active until authentication is
   *  successful.
   *
   *  Parameters:
   *
   *    @param period - The period of the handler.
   *    @param handler - The callback function.
   *
   *  Returns:
   *    @returns A reference to the handler that can be used to remove it.
   */
  addTimedHandler(period: number, handler: () => boolean): TimedHandler {
    const thand = new TimedHandler(period, handler);
    this.addTimeds.push(thand);
    return thand;
  }

  /**
   *  Delete a timed handler for a connection.
   *
   *  This function removes a timed handler from the connection.  The
   *  handRef parameter is *not* the function passed to addTimedHandler(),
   *  but is the reference returned from addTimedHandler().
   *
   *  Parameters:
   *
   *    @param handRef - The handler reference.
   */
  deleteTimedHandler(handRef: TimedHandler): void {
    // this must be done in the Idle loop so that we don't change
    // the handlers during iteration
    this.removeTimeds.push(handRef);
  }

  /**
   *  Add a stanza handler for the connection.
   *
   *  This function adds a stanza handler to the connection.  The
   *  handler callback will be called for any stanza that matches
   *  the parameters.  Note that if multiple parameters are supplied,
   *  they must all match for the handler to be invoked.
   *
   *  The handler will receive the stanza that triggered it as its argument.
   *  *The handler should return true if it is to be invoked again;
   *  returning false will remove the handler after it returns.*
   *
   *  As a convenience, the ns parameters applies to the top level element
   *  and also any of its immediate children.  This is primarily to make
   *  matching /iq/query elements easy.
   *
   *  Options
   *  ~~~~~~~
   *  With the options argument, you can specify boolean flags that affect how
   *  matches are being done.
   *
   *  Currently two flags exist:
   *
   *  - matchBareFromJid:
   *      When set to true, the from parameter and the
   *      from attribute on the stanza will be matched as bare JIDs instead
   *      of full JIDs. To use this, pass {matchBareFromJid: true} as the
   *      value of options. The default value for matchBareFromJid is false.
   *
   *  - ignoreNamespaceFragment:
   *      When set to true, a fragment specified on the stanza's namespace
   *      URL will be ignored when it's matched with the one configured for
   *      the handler.
   *
   *      This means that if you register like this:
   *      >   connection.addHandler(
   *      >       handler,
   *      >       'http://jabber.org/protocol/muc',
   *      >       null, null, null, null,
   *      >       {'ignoreNamespaceFragment': true}
   *      >   );
   *
   *      Then a stanza with XML namespace of
   *      'http://jabber.org/protocol/muc#user' will also be matched. If
   *      'ignoreNamespaceFragment' is false, then only stanzas with
   *      'http://jabber.org/protocol/muc' will be matched.
   *
   *  Deleting the handler
   *  ~~~~~~~~~~~~~~~~~~~~
   *  The return value should be saved if you wish to remove the handler
   *  with deleteHandler().
   *
   *  Parameters:
   *
   *    @param handler - The user callback.
   *    @param ns - The namespace to match.
   *    @param name - The stanza tag name to match.
   *    @param type - The stanza type (or types if an array) to match.
   *    @param id - The stanza id attribute to match.
   *    @param from - The stanza from attribute to match.
   *    @param options - The handler options
   *
   *  Returns:
   *    @returns A reference to the handler that can be used to remove it.
   */
  addHandler(
    handler: (stanza: Element) => boolean,
    ns?: string,
    name?: string,
    type?: string | string[],
    id?: string,
    from?: string,
    options?: { matchBareFromJid: boolean; ignoreNamespaceFragment: boolean }
  ): Handler {
    const hand = new Handler(handler, ns, name, type, id, from, options);
    this.addHandlers.push(hand);
    return hand;
  }

  /**
   *  Delete a stanza handler for a connection.
   *
   *  This function removes a stanza handler from the connection.  The
   *  handRef parameter is *not* the function passed to addHandler(),
   *  but is the reference returned from addHandler().
   *
   *  Parameters:
   *
   *    @param handRef - The handler reference.
   */
  deleteHandler(handRef: Handler): void {
    // this must be done in the Idle loop so that we don't change
    // the handlers during iteration
    this.removeHandlers.push(handRef);
    // If a handler is being deleted while it is being added,
    // prevent it from getting added
    const i = this.addHandlers.indexOf(handRef);
    if (i >= 0) {
      this.addHandlers.splice(i, 1);
    }
  }

  /**
   *  Delete a stanza handler for a connection.
   *
   *  This function removes a stanza handler from the connection.  The
   *  handRef parameter is *not* the function passed to addHandler(),
   *  but is the reference returned from addHandler().
   *
   *  Parameters:
   *
   *    @param handRef - The handler reference.
   */
  deleteHandlerAsync(handRef: HandlerAsync): void {
    // this must be done in the Idle loop so that we don't change
    // the handlers during iteration
    this.removeHandlersAsync.push(handRef);
    // If a handler is being deleted while it is being added,
    // prevent it from getting added
    const i = this.addHandlersAsync.indexOf(handRef);
    if (i >= 0) {
      this.addHandlersAsync.splice(i, 1);
    }
  }

  observeForMatch$(options?: MatcherConfig): Observable<Element> {
    return this.stanzasIn$.pipe(filter((elem) => new Matcher(options).isMatch(elem)));
  }

  /**
   *
   * Register the SASL mechanisms which will be supported by this instance of
   * Connection (i.e. which this XMPP client will support).
   *
   *  Parameters:
   *
   *    @param mechanisms - Array of objects with SASLMechanism prototypes
   *
   */
  registerSASLMechanisms(mechanisms: SASLMechanism[]): void {
    this.mechanisms = [];
    mechanisms =
      mechanisms ||
      ([
        SASLAnonymous,
        SASLExternal,
        SASLOAuthBearer,
        SASLXOAuth2,
        SASLPlain,
        SASLSHA1,
        SASLSHA256,
        SASLSHA384,
        SASLSHA512
      ] as unknown as SASLMechanism[]);
    // @ts-ignore
    mechanisms.forEach((m) => this.registerSASLMechanism(m));
  }

  /**
   *
   * Register a single SASL mechanism, to be supported by this client.
   *
   *  Parameters:
   *
   *    @param mechanism - Constructor for an object with a SASLMechanism prototype
   *
   */
  registerSASLMechanism<T extends SASLMechanism>(mechanism: new () => T): void {
    const tmpMechanism = new mechanism();
    this.mechanisms[tmpMechanism.mechname] = tmpMechanism;
  }

  /**
   *  Start the graceful disconnection process.
   *
   *  This function starts the disconnection process.  This process starts
   *  by sending unavailable presence and sending BOSH body of type
   *  terminate.  A timeout handler makes sure that disconnection happens
   *  even if the BOSH server does not respond.
   *  If the Connection object isn't connected, at least tries to abort all pending requests
   *  so the connection object won't generate successful requests (which were already opened).
   *
   *  The user supplied connection callback will be notified of the
   *  progress as this process happens.
   *
   *  Parameters:
   *
   *    @param reason - The reason the disconnect is occuring.
   */
  disconnect(reason?: string): void {
    this.changeConnectStatus(Status.DISCONNECTING, reason);
    if (reason) {
      warn('Disconnect was called because: ' + reason);
    } else {
      info('Disconnect was called');
    }
    if (this.connected) {
      let pres;
      this.disconnecting = true;
      if (this.authenticated) {
        pres = $pres({
          xmlns: NS.CLIENT,
          type: 'unavailable'
        });
      }
      // setup timeout handler
      this.disconnectTimeout = this._addSysTimedHandler(this.disconnection_timeout, this._onDisconnectTimeout.bind(this));
      // @ts-ignore
      this.protocolManager._disconnect(pres);
    } else {
      warn('Disconnect was called before Strophe connected to the server');
      this.protocolManager._abortAllRequests();
      this.doDisconnect();
    }
  }

  /**
   *
   *  This is the last piece of the disconnection logic.  This resets the
   *  connection and alerts the user's connection callback.
   */
  doDisconnect(reason?: string) {
    if (typeof this.idleTimeout === 'number') {
      clearTimeout(this.idleTimeout);
    }

    // Cancel Disconnect Timeout
    if (this.disconnectTimeout !== null) {
      this.deleteTimedHandler(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }

    debug('_doDisconnect was called');
    this.protocolManager.doDisconnect();

    this.authenticated = false;
    this.disconnecting = false;
    this.restored = false;

    // delete handlers
    this.handlers = [];
    this.timedHandlers = [];
    this.removeTimeds = [];
    this.removeHandlers = [];
    this.addTimeds = [];
    this.addHandlers = [];

    // tell the parent we disconnected
    this.changeConnectStatus(Status.DISCONNECTED, reason);
    this.connected = false;
  }

  /**
   *
   *  Sorts an array of objects with prototype SASLMechanism according to
   *  their priorities.
   *
   *  Parameters:
   *
   *    @param mechanisms - Array of SASL mechanisms.
   *
   */
  sortMechanismsByPriority(mechanisms: SASLMechanism[]): SASLMechanism[] {
    // Sorting mechanisms according to priority.
    for (let i = 0; i < mechanisms.length - 1; ++i) {
      let higher = i;
      for (let j = i + 1; j < mechanisms.length; ++j) {
        if (mechanisms[j].priority > mechanisms[higher].priority) {
          higher = j;
        }
      }
      if (higher !== i) {
        const swap = mechanisms[i];
        mechanisms[i] = mechanisms[higher];
        mechanisms[higher] = swap;
      }
    }
    return mechanisms;
  }

  /**
   * Set up authentication
   *
   *  Continues the initial connection request by setting up authentication
   *  handlers and starting the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  Parameters:
   *
   *    @param matched - Array of SASL mechanisms supported.
   *
   */
  async authenticate(matched: SASLMechanism[]): Promise<void> {
    if (!(await this.attemptSASLAuth(matched))) {
      this.attemptLegacyAuth();
    }
  }

  /**
   *
   *  Iterate through an array of SASL mechanisms and attempt authentication
   *  with the highest priority (enabled) mechanism.
   *
   *  Parameters:
   *    (Array) mechanisms - Array of SASL mechanisms.
   *
   *  Returns:
   *    (Boolean) mechanism_found - true or false, depending on whether a
   *          valid SASL mechanism was found with which authentication could be
   *          started.
   */
  async attemptSASLAuth(mechanisms: SASLMechanism[]): Promise<boolean> {
    mechanisms = this.sortMechanismsByPriority(mechanisms || []);
    let mechanism_found = false;
    for (const mechanism of mechanisms) {
      if (!mechanism.test(this)) {
        continue;
      }
      this.saslSuccessHandler = this.addSysHandler((el) => this.saslSuccessCb(el), null, 'success', null, null);
      this.saslFailureHandler = this.addSysHandler((el) => this.saslFailureCb(el), null, 'failure', null, null);
      this.saslChallengeHandler = this.addSysHandlerPromise((el) => this.saslChallengeCb(el), null, 'challenge', null, null);

      this.saslMechanism = mechanism;
      this.saslMechanism.onStart(this);

      const request_auth_exchange = $build('auth', {
        xmlns: NS.SASL,
        mechanism: this.saslMechanism.mechname
      });
      if (this.saslMechanism.isClientFirst) {
        const response = await this.saslMechanism.clientChallenge(this);
        request_auth_exchange.t(btoa(response));
      }
      this.send(request_auth_exchange.tree());
      mechanism_found = true;
      break;
    }
    return mechanism_found;
  }

  /**
   *  _Private_ handler for the SASL challenge
   *
   */
  async saslChallengeCb(elem: Element): Promise<boolean> {
    const challenge = atob(getText(elem));
    const response = await this.saslMechanism.onChallenge(this, challenge);
    const stanza = $build('response', { xmlns: NS.SASL });
    if (response !== '') {
      stanza.t(btoa(response));
    }
    this.send(stanza.tree());
    return true;
  }

  /**
   *
   *  Attempt legacy (i.e. non-SASL) authentication.
   */
  attemptLegacyAuth() {
    if (getNodeFromJid(this.jid) === null) {
      // we don't have a node, which is required for non-anonymous
      // client connections
      this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.MISSING_JID_NODE);
      this.disconnect(ErrorCondition.MISSING_JID_NODE);
    } else {
      // Fall back to legacy authentication
      this.changeConnectStatus(Status.AUTHENTICATING, null);
      this.addSysHandler(this._onLegacyAuthIQResult.bind(this), null, null, null, '_auth_1');
      this.send(
        $iq({
          type: 'get',
          to: this.domain,
          id: '_auth_1'
        })
          .c('query', { xmlns: NS.AUTH })
          .c('username', {})
          .t(getNodeFromJid(this.jid))
          .tree()
      );
    }
  }

  /**
   *  _Private_ handler for legacy authentication.
   *
   *  This handler is called in response to the initial <iq type='get'/>
   *  for legacy authentication.  It builds an authentication <iq/> and
   *  sends it, creating a handler (calling back to _auth2_cb()) to
   *  handle the result
   *
   *  Parameters:
   *    (XMLElement) elem - The stanza that triggered the callback.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onLegacyAuthIQResult(_elem: Element) {
    // build plaintext auth iq
    const iq = $iq({ type: 'set', id: '_auth_2' })
      .c('query', { xmlns: NS.AUTH })
      .c('username', {})
      .t(getNodeFromJid(this.jid))
      .up()
      .c('password')
      .t(this.pass as string);

    if (!getResourceFromJid(this.jid)) {
      // since the user has not supplied a resource, we pick
      // a default one here.  unlike other auth methods, the server
      // cannot do this for us.
      this.jid = getBareJidFromJid(this.jid) + '/strophe';
    }
    iq.up().c('resource', {}).t(getResourceFromJid(this.jid));

    this.addSysHandler(this._auth2_cb.bind(this), null, null, null, '_auth_2');
    this.send(iq.tree());
    return false;
  }

  /**
   *  _Private_ handler for successful SASL authentication.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  saslSuccessCb(elem: Element) {
    if (this.saslData['server-signature']) {
      let serverSignature;
      const success = atob(getText(elem));
      const attribMatch = /([a-z]+)=([^,]+)(,|$)/;
      const matches = success.match(attribMatch);
      if (matches[1] === 'v') {
        serverSignature = matches[2];
      }
      if (serverSignature !== this.saslData['server-signature']) {
        // remove old handlers
        this.deleteHandler(this.saslFailureHandler);
        this.saslFailureHandler = null;
        if (this.saslChallengeHandler) {
          this.deleteHandlerAsync(this.saslChallengeHandler);
          this.saslChallengeHandler = null;
        }
        this.saslData = {};
        return this.saslFailureCb(null);
      }
    }
    info('SASL authentication succeeded.');

    if (this.saslData.keys) {
      this.scramKeys = this.saslData.keys;
    }

    if (this.saslMechanism) {
      this.saslMechanism.onSuccess();
    }
    // remove old handlers
    this.deleteHandler(this.saslFailureHandler);
    this.saslFailureHandler = null;
    if (this.saslChallengeHandler) {
      this.deleteHandlerAsync(this.saslChallengeHandler);
      this.saslChallengeHandler = null;
    }
    const streamfeature_handlers: Handler[] = [];
    const wrapper = (handlers: Handler[], el: Element) => {
      while (handlers.length) {
        this.deleteHandler(handlers.pop());
      }
      this._onStreamFeaturesAfterSASL(el);
      return false;
    };
    streamfeature_handlers.push(this.addSysHandler((el) => wrapper(streamfeature_handlers, el), null, 'stream:features', null, null));

    streamfeature_handlers.push(this.addSysHandler((el) => wrapper(streamfeature_handlers, el), NS.STREAM, 'features', null, null));

    // we must send a xmpp:restart now
    this._sendRestart();
    return false;
  }

  /**
   *  Send an xmpp:restart stanza.
   */
  _sendRestart() {
    this.data.push($build('restart').tree());
    this.protocolManager._sendRestart();
    // @ts-ignore
    this.idleTimeout = setTimeout(() => this._onIdle(), 100);
  }

  /**
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onStreamFeaturesAfterSASL(elem: Element) {
    // save stream:features for future usage
    this.features = elem;
    for (const child of Array.from(elem.childNodes)) {
      if (child.nodeName === 'bind') {
        this.do_bind = true;
      }
      if (child.nodeName === 'session') {
        this.do_session = true;
      }
    }

    if (!this.do_bind) {
      this.changeConnectStatus(Status.AUTHFAIL, null);
      return false;
    } else if (!this.options.explicitResourceBinding) {
      this.bind();
    } else {
      this.changeConnectStatus(Status.BINDREQUIRED, null);
    }
    return false;
  }

  /**
   *
   *  Sends an IQ to the XMPP server to bind a JID resource for this session.
   *
   *  https://tools.ietf.org/html/rfc6120#section-7.5
   *
   *  If `explicitResourceBinding` was set to a truthy value in the options
   *  passed to the Connection constructor, then this function needs
   *  to be called explicitly by the client author.
   *
   *  Otherwise, it'll be called automatically as soon as the XMPP server
   *  advertises the "urn:ietf:params:xml:ns:xmpp-bind" stream feature.
   */
  bind(): void {
    if (!this.do_bind) {
      log(LogLevel.INFO, `Connection.prototype.bind called but "do_bind" is false`);
      return;
    }
    this.addSysHandler(this._onResourceBindResultIQ.bind(this), null, null, null, '_bind_auth_2');

    const resource = getResourceFromJid(this.jid);
    if (resource) {
      this.send($iq({ type: 'set', id: '_bind_auth_2' }).c('bind', { xmlns: NS.BIND }).c('resource', {}).t(resource).tree());
    } else {
      this.send($iq({ type: 'set', id: '_bind_auth_2' }).c('bind', { xmlns: NS.BIND }).tree());
    }
  }

  /**
   *  _Private_ handler for binding result and session start.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onResourceBindResultIQ(elem: Element) {
    if (elem.getAttribute('type') === 'error') {
      warn('Resource binding failed.');
      const conflict = elem.getElementsByTagName('conflict');
      let condition;
      if (conflict.length > 0) {
        condition = ErrorCondition.CONFLICT;
      }
      this.changeConnectStatus(Status.AUTHFAIL, condition, elem);
      return false;
    }
    // TODO - need to grab errors
    const bind = elem.getElementsByTagName('bind');
    if (bind.length > 0) {
      const jidNode = bind[0].getElementsByTagName('jid');
      if (jidNode.length > 0) {
        this.authenticated = true;
        this.jid = getText(jidNode[0]);
        if (this.do_session) {
          this._establishSession();
        } else {
          this.changeConnectStatus(Status.CONNECTED, null);
        }
      }
      return true;
    } else {
      warn('Resource binding failed.');
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
      return false;
    }
  }

  /**
   *  Send IQ request to establish a session with the XMPP server.
   *
   *  See https://xmpp.org/rfcs/rfc3921.html#session
   *
   *  Note: The protocol for session establishment has been determined as
   *  unnecessary and removed in RFC-6121.
   */
  _establishSession() {
    if (!this.do_session) {
      throw new Error(
        `Strophe.Connection.prototype._establishSession ` + `called but apparently ${NS.SESSION} wasn't advertised by the server`
      );
    }
    this.addSysHandler(this._onSessionResultIQ.bind(this), null, null, null, '_session_auth_2');

    this.send($iq({ type: 'set', id: '_session_auth_2' }).c('session', { xmlns: NS.SESSION }).tree());
  }

  /**
   *  _Private_ handler for the server's IQ response to a client's session
   *  request.
   *
   *  This sets Connection.authenticated to true on success, which
   *  starts the processing of user handlers.
   *
   *  See https://xmpp.org/rfcs/rfc3921.html#session
   *
   *  Note: The protocol for session establishment has been determined as
   *  unnecessary and removed in RFC-6121.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onSessionResultIQ(elem: Element) {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.changeConnectStatus(Status.CONNECTED, null);
    } else if (elem.getAttribute('type') === 'error') {
      this.authenticated = false;
      warn('Session creation failed.');
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
      return false;
    }
    return false;
  }

  /**
   *  _Private_ handler for SASL authentication failure.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  saslFailureCb(elem?: Element): boolean {
    // delete unneeded handlers
    if (this.saslSuccessHandler) {
      this.deleteHandler(this.saslSuccessHandler);
      this.saslSuccessHandler = null;
    }
    if (this.saslChallengeHandler) {
      this.deleteHandlerAsync(this.saslChallengeHandler);
      this.saslChallengeHandler = null;
    }

    if (this.saslMechanism) {
      this.saslMechanism.onFailure();
    }
    this.changeConnectStatus(Status.AUTHFAIL, null, elem);
    return false;
  }

  /**
   *  _Private_ handler to finish legacy authentication.
   *
   *  This handler is called when the result from the jabber:iq:auth
   *  <iq/> stanza is returned.
   *
   *  Parameters:
   *    (XMLElement) elem - The stanza that triggered the callback.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _auth2_cb(elem: Element) {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.changeConnectStatus(Status.CONNECTED, null);
    } else if (elem.getAttribute('type') === 'error') {
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
      this.disconnect('authentication failed');
    }
    return false;
  }

  /**
   *  _Private_ function to add a system level timed handler.
   *
   *  This function is used to add a Strophe.TimedHandler for the
   *  library code.  System timed handlers are allowed to run before
   *  authentication is complete.
   *
   *  Parameters:
   *    (Integer) period - The period of the handler.
   *    (Function) handler - The callback function.
   */
  _addSysTimedHandler(period: number, handler: () => boolean) {
    const thand = new TimedHandler(period, handler);
    thand.user = false;
    this.addTimeds.push(thand);
    return thand;
  }

  /**
   *  _Private_ timeout handler for handling non-graceful disconnection.
   *
   *  If the graceful disconnect process does not complete within the
   *  time allotted, this handler finishes the disconnect anyway.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onDisconnectTimeout(): false {
    debug('_onDisconnectTimeout was called');
    this.changeConnectStatus(Status.CONNTIMEOUT, null);
    this.protocolManager._onDisconnectTimeout();
    // actually disconnect
    this.doDisconnect();
    return false;
  }

  /**
   *  _Private_ helper function that makes sure plugins and the user's
   *  callback are notified of connection status changes.
   *
   *  Parameters:
   *
   *    @param status - the new connection status, one of the values
   *      in Status
   *    @param condition - the error condition or null
   *    @param elem - The triggering stanza.
   */
  changeConnectStatus(status: number, condition?: string, elem?: Element): void {
    // notify all plugins listening for status changes
    for (const k in connectionPlugins) {
      if (Object.prototype.hasOwnProperty.call(connectionPlugins, k)) {
        const plugin = this[k];
        if (plugin.statusChanged) {
          try {
            plugin.statusChanged(status, condition);
          } catch (err) {
            log(LogLevel.ERROR, `${k} plugin caused an exception changing status: ${err}`);
          }
        }
      }
    }
    // notify the user's callback
    if (this.connect_callback) {
      try {
        this.connect_callback(status, condition, elem);
      } catch (e) {
        handleError(e);
        log(LogLevel.ERROR, `User connection callback caused an exception: ${e}`);
      }
    }
  }

  /**
   *  _Private_ handler to processes incoming data from the connection.
   *
   *  Except for _connect_cb handling the initial connection request,
   *  this function handles the incoming data for all requests.  This
   *  function also fires stanza handlers that match each incoming
   *  stanza.
   *
   *  Parameters:
   *
   *    @param req - The request that has data ready.
   */
  _dataRecv(req: Element): void {
    const elem = this.protocolManager._reqToData(req as unknown as any);
    if (elem === null) {
      return;
    }

    if (elem.nodeName === this.protocolManager.strip && Array.isArray(elem.childNodes)) {
      this.xmlInput(elem.childNodes[0]);
      this.stanzasInSubject.next(elem.childNodes[0] as Element);
    } else {
      this.xmlInput(elem);
      this.stanzasInSubject.next(elem);
    }

    // remove handlers scheduled for deletion
    while (this.removeHandlers.length > 0) {
      const hand = this.removeHandlers.pop();
      const i = this.handlers.indexOf(hand);
      if (i >= 0) {
        this.handlers.splice(i, 1);
      }
    }

    // add handlers scheduled for addition
    while (this.addHandlers.length > 0) {
      this.handlers.push(this.addHandlers.pop());
    }

    // handle graceful disconnect
    if (this.disconnecting && this.protocolManager._emptyQueue()) {
      this.doDisconnect();
      return;
    }

    const type = elem.getAttribute('type');
    if (type !== null && type === 'terminate') {
      // Don't process stanzas that come in after disconnect
      if (this.disconnecting) {
        return;
      }
      // an error occurred
      let cond = elem.getAttribute('condition');
      const conflict = elem.getElementsByTagName('conflict');
      if (cond !== null) {
        if (cond === 'remote-stream-error' && conflict.length > 0) {
          cond = 'conflict';
        }
        this.changeConnectStatus(Status.CONNFAIL, cond);
      } else {
        this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.UNKNOWN_REASON);
      }
      this.doDisconnect(cond);
      return;
    }

    // send each incoming stanza through the handler chain
    forEachChild(elem, null, (child) => {
      const matches = [];
      this.handlers = this.handlers.reduce((handlers, handler) => {
        try {
          if (handler.isMatch(child) && (this.authenticated || !handler.user)) {
            if (handler.run(child)) {
              handlers.push(handler);
            }
            matches.push(handler);
          } else {
            handlers.push(handler);
          }
        } catch (e) {
          // if the handler throws an exception, we consider it as false
          warn('Removing Strophe handlers due to uncaught exception: ' + e.message);
        }

        return handlers;
      }, []);

      // If no handler was fired for an incoming IQ with type="set",
      // then we return an IQ error stanza with service-unavailable.
      if (!matches.length && this.iqFallbackHandler.isMatch(child)) {
        this.iqFallbackHandler.run(child);
      }
    });
  }

  /**
   *  This function is used to add a Handler for the
   *  library code.  System stanza handlers are allowed to run before
   *  authentication is complete.
   *
   *  Parameters:
   *
   *    @param {(element: Element) => boolean} handler - The callback function.
   *    @param {string} ns - The namespace to match.
   *    @param {string} name - The stanza name to match.
   *    @param {string} type - The stanza type attribute to match.
   *    @param {string} id - The stanza id attribute to match.
   */
  addSysHandler(handler: (element: Element) => boolean, ns: string, name: string, type: string, id: string): Handler {
    const hand = new Handler(handler, ns, name, type, id);
    hand.user = false;
    this.addHandlers.push(hand);
    return hand;
  }

  /**
   *  This function is used to add a Handler for the
   *  library code.  System stanza handlers are allowed to run before
   *  authentication is complete.
   *
   *  Parameters:
   *
   *    @param {(element: Element) => boolean} handler - The callback function.
   *    @param {string} ns - The namespace to match.
   *    @param {string} name - The stanza name to match.
   *    @param {string} type - The stanza type attribute to match.
   *    @param {string} id - The stanza id attribute to match.
   */
  addSysHandlerPromise(handler: (element: Element) => Promise<boolean>, ns: string, name: string, type: string, id: string): HandlerAsync {
    const hand = new HandlerAsync(handler, ns, name, type, id);
    hand.user = false;
    this.addHandlersAsync.push(hand);
    return hand;
  }

  /**
   *  _Private_ handler to process events during idle cycle.
   *
   *  This handler is called every 100ms to fire timed handlers that
   *  are ready and keep poll requests going.
   */
  _onIdle(): void {
    // add timed handlers scheduled for addition
    // NOTE: we add before remove in the case a timed handler is
    // added and then deleted before the next _onIdle() call.
    while (this.addTimeds.length > 0) {
      this.timedHandlers.push(this.addTimeds.pop());
    }

    // remove timed handlers that have been scheduled for deletion
    while (this.removeTimeds.length > 0) {
      const thand = this.removeTimeds.pop();
      const i = this.timedHandlers.indexOf(thand);
      if (i >= 0) {
        this.timedHandlers.splice(i, 1);
      }
    }

    // call ready timed handlers
    const now = new Date().getTime();
    const newList = [];
    for (const thand of this.timedHandlers) {
      if (this.authenticated || !thand.user) {
        const since = thand.lastCalled + thand.period;
        if (since - now <= 0) {
          if (thand.run()) {
            newList.push(thand);
          }
        } else {
          newList.push(thand);
        }
      }
    }
    this.timedHandlers = newList;
    clearTimeout(this.idleTimeout);
    this.protocolManager._onIdle();

    // reactivate the timer only if connected
    if (this.connected) {
      // @ts-ignore
      this.idleTimeout = setTimeout(() => this._onIdle(), 100);
    }
  }

  /**
   *  _Private_ handler for initial connection request.
   *
   *  This handler is used to process the initial connection request
   *  response from the BOSH server. It is used to set up authentication
   *  handlers and start the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  Parameters:
   *
   *    @param req - The current request.
   *    @param _callback - low level (xmpp) connect callback function.
   *      Useful for plugins with their own xmpp connect callback (when they
   *      want to do something special).
   */
  _connect_cb(req: Element, _callback: () => void) {
    debug('_connect_cb was called');
    this.connected = true;

    let bodyWrap: Element;
    try {
      bodyWrap = this.protocolManager._reqToData(req as unknown as any);
    } catch (e) {
      if (e.name !== ErrorCondition.BAD_FORMAT) {
        throw e;
      }
      this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.BAD_FORMAT);
      this.doDisconnect(ErrorCondition.BAD_FORMAT);
    }
    if (!bodyWrap) {
      return;
    }

    if (bodyWrap.nodeName === this.protocolManager.strip && bodyWrap.childNodes.length) {
      this.xmlInput(bodyWrap.childNodes[0] as Element);
    } else {
      this.xmlInput(bodyWrap);
    }

    const conncheck = this.protocolManager._connect_cb(bodyWrap);
    if (conncheck === Status.CONNFAIL) {
      return;
    }

    // Check for the stream:features tag
    let hasFeatures;
    if (bodyWrap.getElementsByTagNameNS) {
      hasFeatures = bodyWrap.getElementsByTagNameNS(NS.STREAM, 'features').length > 0;
    } else {
      hasFeatures = bodyWrap.getElementsByTagName('stream:features').length > 0 || bodyWrap.getElementsByTagName('features').length > 0;
    }
    if (!hasFeatures) {
      this.protocolManager._no_auth_received(_callback);
      return;
    }

    const matched = Array.from(bodyWrap.getElementsByTagName('mechanism'))
      .map((m) => this.mechanisms[m.textContent])
      .filter((m) => m);

    if (matched.length !== 0 && this.do_authentication !== false) {
      this.authenticate(matched).then(_callback);
    }

    if (bodyWrap.getElementsByTagName('auth').length === 0) {
      // There are no matching SASL mechanisms and also no legacy
      // auth available.
      this.protocolManager._no_auth_received(_callback);
    }
  }

  static async create(
    service: string,
    domain: string,
    authenticationMode = AuthenticationMode.LOGIN,
    prebindUrl?: string,
    credentialsUrl?: string
  ): Promise<Connection> {
    const connectionUrls = this.getConnectionsUrls(service, domain);
    const options = { keepalive: true, explicitResourceBinding: true };

    if (!connectionUrls.boshServiceUrl && !connectionUrls.websocketUrl && connectionUrls.domain) {
      const { boshServiceUrl, websocketUrl } = await this.discoverConnectionMethods(connectionUrls.domain);
      if (!connectionUrls.boshServiceUrl && authenticationMode === AuthenticationMode.PREBIND) {
        throw new Error("authentication is set to 'prebind' but we don't have a BOSH connection");
      }
      return new Connection(
        websocketUrl ?? boshServiceUrl,
        options,
        authenticationMode,
        prebindUrl,
        boshServiceUrl,
        websocketUrl,
        credentialsUrl
      );
    }

    const connection_url = connectionUrls.websocketUrl ?? connectionUrls.boshServiceUrl;
    return new Connection(
      connection_url,
      options,
      authenticationMode,
      prebindUrl,
      connectionUrls.boshServiceUrl,
      connectionUrls.websocketUrl,
      credentialsUrl
    );
  }

  static getConnectionsUrls(service: string, domain: string) {
    const isWebsocket = /wss?:\/\//.test(service);

    return {
      domain,
      boshServiceUrl: isWebsocket ? undefined : service,
      websocketUrl: isWebsocket ? service : undefined
    };
  }

  /**
   * Logs the user in.
   *
   * If called without any parameters, Converse will try
   * to log the user in by calling the `prebind_url` or `credentials_url` depending
   * on whether prebinding is used or not.
   *
   * @param {string} [jid]
   * @param {string} [password]
   * @param {boolean} [automatic=false] - An internally used flag that indicates whether
   *  this method was called automatically once the connection has been
   *  initialized. It's used together with the `auto_login` configuration flag
   *  to determine whether Converse should try to log the user in if it
   *  fails to restore a previous auth'd session.
   *  @returns  {void}
   */
  async login(jid = this.jid, password?: string, automatic = false): Promise<void> {
    if (this.options?.worker && (await this.restoreWorkerSession())) {
      return;
    }
    if (jid) {
      jid = this.setUserJID(jid);
    }

    // See whether there is a BOSH session to re-attach to
    if (this.protocolManager instanceof Bosh && this.protocolManager.restoreBOSHSession()) {
      return;
    }
    if (this.protocolManager instanceof Bosh && this.handlePreBind && !automatic) {
      return this.protocolManager.startNewPreboundBOSHSession();
    }

    const fallBackPassword = typeof this.pass === 'string' ? this.pass : null;

    password = password ?? fallBackPassword;
    const credentials: Credentials = jid && password ? { jid, password } : null;
    await this.attemptNonPreboundSession(credentials, automatic);
  }

  async loginNew(username: string, domain: string, service: string, password: string): Promise<void> {
    const separator = '@';
    const safeUsername = username.indexOf(separator) > -1 ? username.split(separator)[0] : username;
    const jid = safeUsername + separator + domain;

    const conn = await Connection.create(service, domain);
    return new Promise((resolve, reject) => {
      conn.connect(jid, password, this.createConnectionStatusHandler(safeUsername, domain, resolve, reject));
    });
  }

  createConnectionStatusHandler(username: string, domain: string, resolve: () => void, reject: (reason?: string) => void) {
    return (status: Status, value: string) => {
      log(LogLevel.INFO, `status update; status=${status}, value=${JSON.stringify(value)}`);

      switch (status) {
        case Status.REDIRECT:
        case Status.ATTACHED:
        case Status.CONNECTING:
        // @ts-ignore
        case StropheStatusRegister.REGISTER:
        // @ts-ignore
        case StropheStatusRegister.REGISTERED:
          break;
        case Status.AUTHENTICATING:
          break;
        case Status.CONNECTED:
          resolve();
          break;
        case Status.ERROR:
        case Status.CONNFAIL:
        case Status.AUTHFAIL:
        case Status.CONNTIMEOUT:
        // @ts-ignore
        case StropheStatusRegister.CONFLICT:
        // @ts-ignore
        case StropheStatusRegister.REGIFAIL:
        // @ts-ignore
        case StropheStatusRegister.NOTACCEPTABLE:
          reject(`${errorMessages[status]}, failed with status code: ${status}`);
          break;
        case Status.BINDREQUIRED:
          this.bind();
          break;
        case Status.DISCONNECTING:
        case Status.DISCONNECTED:
          break;
        default:
          log(LogLevel.ERROR, `Unhandled connection status; status=${status}`);
      }

      this.stateSubject.next(status);
    };
  }

  /**
   * Adds support for XEP-0156 by querying the XMPP server for alternate
   * connection methods. This allows users to use the websocket or BOSH
   * connection of their own XMPP server instead of a proxy provided by the
   * host of Converse.js.
   *
   * @param domain the xmpp server domain to requests the connection urls from
   */
  static async discoverConnectionMethods(domain: string): Promise<{ websocketUrl: string; boshServiceUrl: string }> {
    // Use XEP-0156 to check whether this host advertises websocket or BOSH connection methods.
    const options = {
      mode: 'cors' as RequestMode,
      headers: {
        Accept: 'application/xrd+xml, text/xml'
      }
    };
    const url = `https://${domain}/.well-known/host-meta`;
    let response: globalThis.Response;
    try {
      response = await fetch(url, options);
    } catch (e) {
      log(LogLevel.ERROR, `Failed to discover alternative connection methods at ${url}`);
      log(LogLevel.ERROR, e);
      return null;
    }
    if (response.status >= 200 && response.status < 400) {
      const text = await response.text();
      return this.onDomainDiscovered(text);
    }

    log(LogLevel.WARN, 'Could not discover XEP-0156 connection methods');
    return null;
  }

  static onDomainDiscovered(xmlBody: string): { websocketUrl: string; boshServiceUrl: string } {
    const xrd = new window.DOMParser().parseFromString(xmlBody, 'text/xml').firstElementChild;
    if (xrd.nodeName != 'XRD' || xrd.getAttribute('xmlns') != 'http://docs.oasis-open.org/ns/xri/xrd-1.0') {
      log(LogLevel.WARN, 'Could not discover XEP-0156 connection methods');
      return null;
    }

    const bosh_links = xrd.querySelectorAll(`Link[rel="urn:xmpp:alt-connections:xbosh"]`);
    const ws_links = xrd.querySelectorAll(`Link[rel="urn:xmpp:alt-connections:websocket"]`);
    const bosh_methods = Array.from(bosh_links).map((el) => el.getAttribute('href'));
    const ws_methods = Array.from(ws_links).map((el) => el.getAttribute('href'));

    if (bosh_methods.length !== 0 && ws_methods.length !== 0) {
      log(LogLevel.WARN, 'Neither BOSH nor WebSocket connection methods have been specified with XEP-0156.');
      return null;
    }

    const websocketUrl = ws_methods.pop();
    const boshServiceUrl = bosh_methods.pop();
    return { websocketUrl, boshServiceUrl };
  }

  private _queueData(element: Element): void {
    if (element === null || !element.tagName || !element.childNodes) {
      const stropheError = new Error('Cannot queue non-DOMElement.');
      stropheError.name = 'StropheError';
      throw stropheError;
    }
    this.data.push(element);
  }

  restoreWorkerSession(): PromiseWrapper<unknown> {
    // @ts-ignore
    this.attach(this.onConnectStatusChanged.bind(this));
    this.workerPromise = getOpenPromise();
    return this.workerPromise;
  }

  async attemptNonPreboundSession(credentials?: Credentials, automatic = false): Promise<void> {
    if (this.authenticationMode === AuthenticationMode.LOGIN) {
      // XXX: If EITHER ``keepalive`` or ``auto_login`` is ``true`` and
      // ``authentication`` is set to ``login``, then Converse will try to log the user in,
      // since we don't have a way to distinguish between whether we're
      // restoring a previous session (``keepalive``) or whether we're
      // automatically setting up a new session (``auto_login``).
      // So we can't do the check (!automatic || _converse.api.settings.get("auto_login")) here.
      if (credentials) {
        await this.connectNonPreboundSession(credentials);
      } else if (this.credentialsUrl) {
        // We give credentials_url preference, because
        // _converse.connection.pass might be an expired token.
        await this.connectNonPreboundSession(await this.getLoginCredentials(this.credentialsUrl));
      } else if (this.jid && (this.password || (this as unknown as any).pass)) {
        await this.connectNonPreboundSession();
      } else if ('credentials' in navigator) {
        await this.connectNonPreboundSession(await this.getLoginCredentialsFromBrowser());
      } else {
        log(LogLevel.WARN, "attemptNonPreboundSession: Couldn't find credentials to log in with");
      }
    } else if ([AuthenticationMode.ANONYMOUS, AuthenticationMode.EXTERNAL].includes(this.authenticationMode) && !automatic) {
      await this.connectNonPreboundSession();
    }
  }

  async getLoginCredentialsFromBrowser(): Promise<{ password: any; jid: string }> {
    try {
      // https://github.com/microsoft/TypeScript/issues/34550
      const creds = await navigator.credentials.get({ password: true } as unknown);
      if (creds && creds.type == 'password' && Connection.isValidJID(creds.id)) {
        this.setUserJID(creds.id);
        return { jid: creds.id, password: (creds as unknown as any).password };
      }
    } catch (e) {
      log(LogLevel.ERROR, e);
    }
    return null;
  }

  private static isValidJID(jid: string): boolean {
    if (typeof jid === 'string') {
      return jid.trim().split('@').length === 2 && !jid.startsWith('@') && !jid.endsWith('@');
    }
    return false;
  }

  fetchLoginCredentialsInterceptor = async (xhr: XMLHttpRequest): Promise<XMLHttpRequest> => xhr;

  async getLoginCredentials(credentialsURL: string): Promise<Credentials> {
    let credentials;
    let wait = 0;
    while (!credentials) {
      try {
        credentials = await this.fetchLoginCredentials(wait, credentialsURL);
      } catch (e) {
        log(LogLevel.ERROR, 'Could not fetch login credentials');
        log(LogLevel.ERROR, e);
      }
      // If unsuccessful, we wait 2 seconds between subsequent attempts to
      // fetch the credentials.
      wait = 2000;
    }
    return credentials;
  }

  async fetchLoginCredentials(wait = 0, credentialsURL: string): Promise<Credentials> {
    return firstValueFrom(
      fromRxjs<Promise<Credentials>>(
        new Promise(async (resolve, reject) => {
          let xhr = new XMLHttpRequest();
          xhr.open('GET', credentialsURL, true);
          xhr.setRequestHeader('Accept', 'application/json, text/javascript');
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 400) {
              const data = JSON.parse(xhr.responseText);
              this.setUserJID(data.jid);
              resolve({
                jid: data.jid,
                password: data.password
              });
            } else {
              reject(new Error(`${xhr.status}: ${xhr.responseText}`));
            }
          };
          xhr.onerror = reject;
          /**
           * *Hook* which allows modifying the server request
           *
           * @event _converse#beforeFetchLoginCredentials
           */
          xhr = await this.fetchLoginCredentialsInterceptor(xhr);
          xhr.send();
        })
      ).pipe(debounceTime(wait))
    );
  }

  async connectNonPreboundSession(credentials?: Credentials, automaticLogin?: boolean) {
    if ([AuthenticationMode.ANONYMOUS, AuthenticationMode.EXTERNAL].includes(this.authenticationMode)) {
      if (!this.jid) {
        throw new Error(
          'Config Error: when using anonymous login ' +
            "you need to provide the server's domain via the 'jid' option. " +
            'Either when calling converse.initialize, or when calling ' +
            '_converse.api.user.login.'
        );
      }
      if (!this.reconnecting) {
        this.reset();
      }
      await this.connect(this.jid.toLowerCase(), null);
    } else if (this.authenticationMode === AuthenticationMode.LOGIN) {
      const password = credentials ? credentials.password : (this as unknown as any).pass ?? this.password;
      if (!password) {
        if (automaticLogin) {
          throw new Error('autoLogin: If you use auto_login and ' + "authentication='login' then you also need to provide a password.");
        }
        this.setDisconnectionCause(Status.AUTHFAIL, undefined, true);
        this.disconnect('');
        return;
      }
      if (!this.reconnecting) {
        this.reset();
      }
      await this.connect(this.jid, password);
    }
  }

  static generateResource() {
    return `/ngx-chat-${Math.floor(Math.random() * 139749528).toString()}`;
  }

  /**
   * Switch to a different transport if a service URL is available for it.
   *
   * When reconnecting with a new transport, we call setUserJID
   * so that a new resource is generated, to avoid multiple
   * server-side sessions with the same resource.
   *
   * We also call `_proto._doDisconnect` so that connection event handlers
   * for the old transport are removed.
   */
  switchTransport(): void {
    if (this.protocolManager instanceof StropheWebsocket && this.boshServiceUrl) {
      this.setUserJID(this.bareJid);
      this.doDisconnect();
      this.protocolManager = new Bosh(this, null);
      this.service = this.boshServiceUrl;
    } else if (this.protocolManager instanceof Bosh && this.websocketUrl) {
      if (this.authenticationMode === AuthenticationMode.ANONYMOUS) {
        // When reconnecting anonymously, we need to connect with only
        // the domain, not the full JID that we had in our previous
        // (now failed) session.
        this.setUserJID(this.domainJid);
      } else {
        this.setUserJID(this.bareJid);
      }
      this.doDisconnect();
      this.protocolManager = new StropheWebsocket(this, this.stanzasInSubject);
      this.service = this.websocketUrl;
    }
  }

  async reconnect(): Promise<void> {
    log(LogLevel.DEBUG, 'RECONNECTING: the connection has dropped, attempting to reconnect.');
    this.reconnecting = true;

    const isAuthenticationAnonymous = this.authenticationMode === AuthenticationMode.ANONYMOUS;

    if (this.connectionStatus.status === Status.CONNFAIL) {
      this.switchTransport();
    } else if (this.connectionStatus.status === Status.AUTHFAIL && isAuthenticationAnonymous) {
      // When reconnecting anonymously, we need to connect with only
      // the domain, not the full JID that we had in our previous
      // (now failed) session.
      this.setUserJID(this.domainJid);
    }

    this.setConnectionStatus(Status.RECONNECTING, 'The connection has dropped, attempting to reconnect.');
    /**
     * Triggered when the connection has dropped, but we will attempt
     * to reconnect again.
     */
    this.willReconnectSubject.next();

    await this.login();
  }

  async logOut(): Promise<void> {
    await new Promise((resolve) => this.sendPresence($pres({ type: 'unavailable' }), resolve));
    this.stateSubject.next(Status.DISCONNECTED); // after last send
    this.disconnect('regular logout');
    this.reset();
  }

  /**
   * Promise resolves if user account is registered successfully,
   * rejects if an error happens while registering, e.g. the username is already taken.
   */
  async register(username: string, password: string, service: string, domain: string): Promise<void> {
    const nsRegister = 'jabber:iq:register';

    let registering = false;
    let processed_features = false;
    let connect_cb_data: { req: Element } = { req: null };

    if (username.indexOf('@') > -1) {
      log(LogLevel.WARN, 'username should not contain domain, only local part, this can lead to errors!');
    }

    await this.logOut();
    const conn = await Connection.create(service, domain);

    const readyToStartRegistration = new Promise<void>((resolve) => {
      // hooking strophe's _connect_cb
      const connect_callback = conn._connect_cb.bind(conn);
      conn._connect_cb = (req, callback) => {
        if (registering) {
          // Save this request in case we want to authenticate later
          connect_cb_data = { req };
          resolve();
          return;
        }

        if (processed_features) {
          // exchange Input hooks to not print the stream:features twice
          const xmlInput = (el: Element): void => conn.xmlInput(el);
          conn.xmlInput = () => {};
          connect_callback(req, callback);
          conn.xmlInput = xmlInput;
        }

        connect_callback(req, callback);
      };

      // hooking strophe`s authenticate
      const auth_old = async (matched: SASLMechanism[]): Promise<void> => conn.authenticate(matched);
      conn.authenticate = async (matched: SASLMechanism[]): Promise<void> => {
        const isMatched = typeof matched !== 'undefined';
        if (isMatched) {
          await auth_old(matched);
          return;
        }

        if (!username || !domain || !password) {
          return;
        }

        conn.jid = username + '@' + domain;
        conn.authzid = getBareJidFromJid(conn.jid);
        conn.authcid = getNodeFromJid(conn.jid);
        conn.pass = password;

        const req = connect_cb_data.req;
        conn._connect_cb(req, connect_callback);
      };
    });

    // anonymous connection
    await conn.connect(
      domain,
      '',
      this.createConnectionStatusHandler(
        username,
        domain,
        () => {},
        () => {}
      )
    );

    registering = true;
    await readyToStartRegistration;

    await this.queryForRegistrationForm(conn, nsRegister);
    await this.submitRegisterInformationQuery(conn, username, password, nsRegister);

    registering = false;
    processed_features = true;
    // here we should have switched after processing the feature's stanza to the regular callback after login
    conn.reset();
    await this.logOut();
    await this.loginNew(username, domain, service, password);
  }

  private async queryForRegistrationForm(conn: Connection, nsRegister: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // send a get request for registration, to get all required data fields
      conn.addSysHandler(
        (stanza) => {
          const query = stanza.getElementsByTagName('query');
          if (query.length !== 1) {
            conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
            reject('registration failed by unknown reason');
            return false;
          }

          conn.changeConnectStatus(Status.REGISTER, null);

          resolve();
          return false;
        },
        null,
        'iq',
        null,
        null
      );

      conn.sendIQ($iq({ type: 'get' }).c('query', { xmlns: nsRegister }).tree());
    });
  }

  private async submitRegisterInformationQuery(conn: Connection, username: string, password: string, nsRegister: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      conn.addSysHandler(
        (stanza) => {
          let error = null;

          if (stanza.getAttribute('type') === 'error') {
            error = stanza.getElementsByTagName('error');
            if (error.length !== 1) {
              conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
              reject();
              return false;
            }

            // this is either 'conflict' or 'not-acceptable'
            error = error[0].firstChild.nodeName.toLowerCase();
            if (error === 'conflict') {
              conn.changeConnectStatus(Status.CONFLICT, error);
              reject();
            } else if (error === 'not-acceptable') {
              conn.changeConnectStatus(Status.NOTACCEPTABLE, error);
              reject();
            } else {
              conn.changeConnectStatus(Status.REGIFAIL, error);
              reject();
            }
          } else {
            conn.changeConnectStatus(Status.REGISTERED, null);
            resolve();
          }

          return false; // makes strophe delete the sysHandler
        },
        null,
        'iq',
        null,
        null
      );

      conn.sendIQ($iq({ type: 'set' }).c('query', { xmlns: nsRegister }).c('username', {}, username).c('password', {}, password));
    });
  }

  /**
   * Called as soon as a new connection has been established, either
   * by logging in or by attaching to an existing BOSH session.
   *
   * @method Connection.onConnected
   * @param {boolean} reconnecting - Whether we reconnected from an earlier dropped session.
   */
  onConnected(reconnecting: boolean): void {
    delete this.reconnecting;
    this.flush(); // Solves problem of returned PubSub BOSH response not received by browser
    this.setUserJID(this.jid);

    /**
     * Synchronous event triggered after we've sent an IQ to bind the
     * user's JID resource for this session.
     */
    this.afterResourceBindingSubject.next();

    if (reconnecting) {
      /**
       * After the connection has dropped and we have reconnected.
       * Any Strophe stanza handlers will have to be registered anew.
       */
      this.reconnectedSubject.next();
    } else {
      /**
       * Triggered after the connection has been established
       */
      this.connectedSubject.next();
    }
  }

  /**
   * Used to keep track of why we got disconnected, so that we can
   * decide on what the next appropriate action is (in onDisconnected)
   *
   * @method Connection.setDisconnectionCause
   * @param {number} cause - The status number as received from
   * @param {string} [reason] - An optional user-facing message as to why
   *  there was a disconnection.
   * @param {boolean} [override] - An optional flag to replace any previous
   *  disconnection cause and reason.
   */
  setDisconnectionCause(cause: number, reason?: string, override = false): void {
    if (cause === undefined) {
      delete this.disconnectionCause;
      delete this.disconnectionReason;
    } else if (this.disconnectionCause === undefined || override) {
      this.disconnectionCause = cause;
      this.disconnectionReason = reason;
    }
  }

  setConnectionStatus(status: Status, message: string): void {
    this.status = status;
    this.connectionStatus = { status, message };
  }

  async finishDisconnection(): Promise<void> {
    // Properly tear down the session so that it's possible to manually connect again.
    log(LogLevel.DEBUG, 'DISCONNECTED');
    delete this.reconnecting;
    this.reset();
    await this.clearSession();
    /**
     * Triggered after we disconnected from the XMPP server.
     */
    this.disconnectedSubject.next();
  }

  /**
   * Gets called once strophe's status reaches Status.DISCONNECTED.
   * Will either start a teardown process for converse.js or attempt
   * to reconnect.
   *
   */
  async onDisconnected(automaticLogin?: boolean): Promise<void> {
    if (!automaticLogin) {
      await this.finishDisconnection();
      return;
    }

    const reason = this.disconnectionReason;
    const authFailed = this.disconnectionCause === Status.AUTHFAIL;
    if ((authFailed && this.credentialsUrl) || this.authenticationMode === AuthenticationMode.ANONYMOUS) {
      // If `credentials_url` is set, we reconnect, because we might
      // be receiving expirable tokens from the credentials_url.
      //
      // If `authentication` is anonymous, we reconnect because we
      // might have tried to attach with stale BOSH session tokens
      // or with a cached JID and password
      await this.reconnect();
      return;
    }

    if (authFailed) {
      await this.finishDisconnection();
      return;
    }

    if (this.connectionStatus.status === Status.CONNECTING) {
      // Don't try to reconnect if we were never connected to begin
      // with, otherwise an infinite loop can occur (e.g. when the
      // BOSH service URL returns a 404).
      this.setConnectionStatus(Status.CONNFAIL, 'An error occurred while connecting to the chat server.');
      await this.finishDisconnection();
      return;
    }

    if (
      this.disconnectionCause === Status.DISCONNECTING ||
      reason === ErrorCondition.NO_AUTH_MECH ||
      reason === 'host-unknown' ||
      reason === 'remote-connection-failed'
    ) {
      await this.finishDisconnection();
      return;
    }

    await this.reconnect();
  }

  // TODO: Ensure can be replaced by strophe-connection.service then delete
  /**
   * Callback method called by Strophe as the Connection goes
   * through various states while establishing or tearing down a
   * connection.
   *
   * @param {number} status
   * @param {string} message
   */
  async onConnectStatusChanged(status: Status, message: string): Promise<void> {
    log(LogLevel.DEBUG, `Status changed to: ${this.CONNECTION_STATUS[status]}`);
    if (status === Status.ATTACHFAIL) {
      this.setConnectionStatus(status, message);
      this.workerPromise?.resolve(false);
    } else if (status === Status.CONNECTED || status === Status.ATTACHED) {
      if (this.workerPromise?.isResolved && this.connectionStatus.status === Status.ATTACHED) {
        // A different tab must have attached, so nothing to do for us here.
        return;
      }
      this.setConnectionStatus(status, message);
      this.workerPromise?.resolve(true);

      // By default, we always want to send out an initial presence stanza.
      this.sendInitialPresence = true;
      this.setDisconnectionCause(undefined);
      if (this.reconnecting) {
        log(LogLevel.DEBUG, status === Status.CONNECTED ? 'Reconnected' : 'Reattached');
        this.onConnected(true);
      } else {
        log(LogLevel.DEBUG, status === Status.CONNECTED ? 'Connected' : 'Attached');
        if (this.restored) {
          // No need to send an initial presence stanza when
          // we're restoring an existing session.
          this.sendInitialPresence = false;
        }
        this.onConnected(false);
      }
    } else if (status === Status.DISCONNECTED) {
      this.setDisconnectionCause(status, message);
      await this.onDisconnected();
    } else if (status === Status.BINDREQUIRED) {
      this.bind();
    } else if (status === Status.ERROR) {
      this.setConnectionStatus(status, 'An error occurred while connecting to the chat server.');
    } else if (status === Status.CONNECTING) {
      this.setConnectionStatus(status, message);
    } else if (status === Status.AUTHENTICATING) {
      this.setConnectionStatus(status, message);
    } else if (status === Status.AUTHFAIL) {
      if (!message) {
        message = 'Your XMPP address and/or password is incorrect. Please try again.';
      }
      this.setConnectionStatus(status, message);
      this.setDisconnectionCause(status, message, true);
      await this.onDisconnected();
    } else if (status === Status.CONNFAIL) {
      let feedback = message;
      if (message === 'host-unknown' || message == 'remote-connection-failed') {
        feedback = 'Sorry, we could not connect to the XMPP host with domain: ' + this.domainJid;
      } else if (message !== undefined && message === ErrorCondition?.NO_AUTH_MECH) {
        feedback = 'The XMPP server did not offer a supported authentication mechanism';
      }
      this.setConnectionStatus(status, feedback);
      this.setDisconnectionCause(status, message);
    } else if (status === Status.DISCONNECTING) {
      this.setDisconnectionCause(status, message);
    }
  }

  private clearSession(): void {
    delete this.domainJid;
    delete this.bareJid;
    delete this.session;
    this.setProtocol();
  }

  killSessionBosh(): void {
    this.clearSession();
  }
}
