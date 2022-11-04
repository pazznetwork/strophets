import { SASLMechanismBase } from './sasl';
import { clientChallenge, scramResponse } from './scram';
import { Connection } from './connection';

export class SASLSHA384 extends SASLMechanismBase {
  /** PrivateConstructor: SASLSHA384
   *  SASL SCRAM SHA 384 authentication.
   */
  constructor() {
    super('SCRAM-SHA-384', true, 71);
  }

  test(connection: Connection): boolean {
    return connection.authcid !== null;
  }

  async onChallenge(connection: Connection, challenge?: string): Promise<string> {
    return (await scramResponse(connection, challenge, 'SHA-384', 384)).toString();
  }

  async clientChallenge(connection: Connection, test_cnonce: string): Promise<string> {
    return clientChallenge(connection, test_cnonce);
  }
}
