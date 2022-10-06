import { Connection } from './connection';

/**
 *  encapsulates SASL authentication mechanisms.
 *
 *  User code may override the priority for each mechanism or disable it completely.
 *  See <priority> for information about changing priority and <test> for information on
 *  how to disable a mechanism.
 *
 *  By default, all mechanisms are enabled and the priorities are
 *
 *  SCRAM-SHA1 - 40
 *  DIGEST-MD5 - 30
 *  Plain - 20
 */
export interface SASLMechanism {
  readonly mechname: string;

  /**
   *  Determines which <SASLMechanism> is chosen for authentication (Higher is better).
   *  Users may override this to prioritize mechanisms differently.
   *
   *  In the default configuration the priorities are
   *
   *  SCRAM-SHA1 - 40
   *  DIGEST-MD5 - 30
   *  Plain - 20
   *
   *  Example: (This will cause Strophe to choose the mechanism that the server sent first)
   *
   *  > Strophe.SASLMD5.priority = Strophe.SASLSHA1.priority;
   *
   *  See <SASL mechanisms> for a list of available mechanisms.
   *
   */
  readonly priority: number;

  readonly isClientFirst: boolean;

  /**
   *  Checks if mechanism able to run.
   *  To disable a mechanism, make this return false;
   *
   *  To disable plain authentication run
   *  > Strophe.SASLPlain.test = function() {
   *  >   return false;
   *  > }
   *
   *  See <SASL mechanisms> for a list of available mechanisms.
   *
   *  Parameters:
   *    (Strophe.Connection) connection - Target Connection.
   *
   *  Returns:
   *
   *  @returns (Boolean) If mechanism was able to run.
   */
  test(connection: Connection): boolean;

  /**
   *  Called by protocol implementation on incoming challenge.
   *
   *  By default, if the client is expected to send data first (isClientFirst === true),
   *  this method is called with `challenge` as null on the first call,
   *  unless `clientChallenge` is overridden in the relevant subclass.
   *
   *  Parameters:
   *    (Strophe.Connection) connection - Target Connection.
   *    (String) challenge - current challenge to handle.
   *
   *  Returns:
   *    (String) Mechanism response.
   */
  onChallenge(connection: Connection, challenge?: string): Promise<string>;

  /**
   *  Called before starting mechanism on some connection.
   *
   *  Parameters:
   *    (Strophe.Connection) connection - Target Connection.
   */
  onStart(connection: Connection): void;

  /**
   *  Protocol informs mechanism implementation about SASL failure.
   */
  onFailure(): void;

  /**
   *  Protocol informs mechanism implementation about SASL success.
   */
  onSuccess(): void;

  /** PrivateFunction: clientChallenge
   *  Called by the protocol implementation if the client is expected to send
   *  data first in the authentication exchange (i.e. isClientFirst === true).
   *
   *  Parameters:
   *    (Strophe.Connection) connection - Target Connection.
   *
   *  Returns:
   *    (String) Mechanism response.
   */
  clientChallenge(connection: Connection, challenge?: string): Promise<string>;
}

export abstract class SASLMechanismBase implements SASLMechanism {
  private _connection: Connection;

  protected constructor(readonly mechname: string, readonly isClientFirst: boolean, readonly priority: number) {}

  abstract onChallenge(connection: Connection, challenge?: string): Promise<string>;

  abstract test(connection: Connection): boolean;

  onStart(connection: Connection): void {
    this._connection = connection;
  }

  /** PrivateFunction: onFailure
   *  Protocol informs mechanism implementation about SASL failure.
   */
  onFailure(): void {
    this._connection = null;
  }

  /** PrivateFunction: onSuccess
   *  Protocol informs mechanism implementation about SASL success.
   */
  onSuccess(): void {
    this._connection = null;
  }

  /** PrivateFunction: clientChallenge
   *  Called by the protocol implementation if the client is expected to send
   *  data first in the authentication exchange (i.e. isClientFirst === true).
   *
   *  Parameters:
   *    (Strophe.Connection) connection - Target Connection.
   *
   *  Returns:
   *    (String) Mechanism response.
   */
  clientChallenge(connection: Connection, challenge?: string): Promise<string> {
    if (!this.isClientFirst) {
      throw new Error('clientChallenge should not be called if isClientFirst is false!');
    }
    return this.onChallenge(connection, challenge);
  }
}
