import { SASLMechanism } from './sasl-mechanism';
import { Handler } from './handler';
import { HandlerAsync } from './handlerAsync';
import { SASLAnonymous } from './sasl-anon';
import { SASLExternal } from './sasl-external';
import { SASLOAuthBearer } from './sasl-oauthbearer';
import { SASLXOAuth2 } from './sasl-xoauth2';
import { SASLPlain } from './sasl-plain';
import { SASLSHA1 } from './sasl-sha1';
import { SASLSHA256 } from './sasl-sha256';
import { SASLSHA384 } from './sasl-sha384';
import { SASLSHA512 } from './sasl-sha512';
import { $build } from './builder-helper';
import { NS } from './namespace';
import { getBareJidFromJid, getNodeFromJid, getText } from './xml';
import { info } from './log';
import { Status } from './status';
import { Connection } from './connection';

export class Sasl {
  saslData: Record<string, unknown> = {};
  doBind = false;
  doSession = false;
  mechanism: Record<string, SASLMechanism>;
  mechanisms: SASLMechanism[] = [];

  saslSuccessHandler: Handler;
  saslFailureHandler: Handler;
  saslChallengeHandler: HandlerAsync;
  saslMechanism: SASLMechanism;

  scramKeys: unknown;

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

  constructor(readonly connection: Connection) {}

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
      if (!mechanism.test(this.connection)) {
        continue;
      }
      this.saslSuccessHandler = this.connection.addSysHandler((el) => this.saslSuccessCb(el), null, 'success', null, null);
      this.saslFailureHandler = this.connection.addSysHandler((el) => this.saslFailureCb(el), null, 'failure', null, null);
      this.saslChallengeHandler = this.connection.addSysHandlerPromise((el) => this.saslChallengeCb(el), null, 'challenge', null, null);

      this.saslMechanism = mechanism;
      this.saslMechanism.onStart(this.connection);

      const request_auth_exchange = $build('auth', {
        xmlns: NS.SASL,
        mechanism: this.saslMechanism.mechname
      });
      if (this.saslMechanism.isClientFirst) {
        const response = await this.saslMechanism.clientChallenge(this.connection);
        request_auth_exchange.t(btoa(response));
      }
      this.connection.send(request_auth_exchange.tree());
      mechanism_found = true;
      break;
    }
    return mechanism_found;
  }

  /**
   *  handler for the SASL challenge
   *
   */
  async saslChallengeCb(elem: Element): Promise<boolean> {
    const challenge = atob(getText(elem));
    const response = await this.saslMechanism.onChallenge(this.connection, challenge);
    const stanza = $build('response', { xmlns: NS.SASL });
    if (response !== '') {
      stanza.t(btoa(response));
    }
    this.connection.send(stanza.tree());
    return true;
  }

  /**
   *  handler for successful SASL authentication.
   *
   *  Parameters:
   *
   *   @param (XMLElement) elem - The matching stanza.
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
        this.connection.deleteHandler(this.saslFailureHandler);
        this.saslFailureHandler = null;
        if (this.saslChallengeHandler) {
          this.connection.deleteHandlerAsync(this.saslChallengeHandler);
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
    this.connection.deleteHandler(this.saslFailureHandler);
    this.saslFailureHandler = null;
    if (this.saslChallengeHandler) {
      this.connection.deleteHandlerAsync(this.saslChallengeHandler);
      this.saslChallengeHandler = null;
    }
    const streamfeature_handlers: Handler[] = [];
    const wrapper = (handlers: Handler[], el: Element) => {
      while (handlers.length) {
        this.connection.deleteHandler(handlers.pop());
      }
      this._onStreamFeaturesAfterSASL(el);
      return false;
    };
    streamfeature_handlers.push(
      this.connection.addSysHandler((el) => wrapper(streamfeature_handlers, el), null, 'stream:features', null, null)
    );

    streamfeature_handlers.push(
      this.connection.addSysHandler((el) => wrapper(streamfeature_handlers, el), NS.STREAM, 'features', null, null)
    );

    // we must send a xmpp:restart now
    this._sendRestart();
    return false;
  }

  /**
   *  Send an xmpp:restart stanza.
   */
  _sendRestart() {
    this.connection.data.push($build('restart').tree());
    this.connection.protocolManager.sendRestart();
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
    this.connection.features = elem;
    for (const child of Array.from(elem.childNodes)) {
      if (child.nodeName === 'bind') {
        this.doBind = true;
      }
      if (child.nodeName === 'session') {
        this.doSession = true;
      }
    }

    if (!this.doBind) {
      this.connection.changeConnectStatus(Status.AUTHFAIL, null);
      return false;
    } else if (!this.connection.options.explicitResourceBinding) {
      this.connection.bind();
    } else {
      this.connection.changeConnectStatus(Status.BINDREQUIRED, null);
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
      this.connection.deleteHandler(this.saslSuccessHandler);
      this.saslSuccessHandler = null;
    }
    if (this.saslChallengeHandler) {
      this.connection.deleteHandlerAsync(this.saslChallengeHandler);
      this.saslChallengeHandler = null;
    }

    if (this.saslMechanism) {
      this.saslMechanism.onFailure();
    }
    this.connection.changeConnectStatus(Status.AUTHFAIL, null, elem);
    return false;
  }

  setVariables(jid: string, pass: string, authcid?: string): void {
    /** Variable: authzid
     *  Authorization identity.
     */
    this.authzid = getBareJidFromJid(jid);

    /** Variable: authcid
     *  Authentication identity (User name).
     */
    this.authcid = authcid || getNodeFromJid(jid);

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
  }
}
