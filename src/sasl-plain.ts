import { SASLMechanismBase } from './sasl';
import { Connection } from './connection';
import { utf16to8 } from './utils';

export class SASLPlain extends SASLMechanismBase {
  /** PrivateConstructor: SASLPlain
   *  SASL PLAIN authentication.
   */
  constructor() {
    super('PLAIN', true, 50);
  }

  test(connection: Connection): boolean {
    return connection.authcid !== null;
  }

  async onChallenge(connection: Connection): Promise<string> {
    const { authcid, authzid, domain, pass } = connection;
    if (!domain) {
      throw new Error('SASLPlain onChallenge: domain is not defined!');
    }
    // Only include authzid if it differs from authcid.
    // See: https://tools.ietf.org/html/rfc6120#section-6.3.8
    let auth_str = authzid !== `${authcid}@${domain}` ? authzid : '';
    auth_str = auth_str + '\u0000';
    auth_str = auth_str + authcid;
    auth_str = auth_str + '\u0000';
    auth_str = auth_str + pass;
    return utf16to8(auth_str);
  }
}
