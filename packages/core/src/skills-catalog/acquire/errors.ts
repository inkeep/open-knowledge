export class SkillFetchError extends Error {}

export class SkillDestinationPolicyError extends SkillFetchError {
  readonly origin: string;

  constructor(origin: string, configurationInvalid = false) {
    const canonicalOrigin = new URL(origin).origin;
    super(
      `Website skills require public addresses. Approve ${canonicalOrigin} in user skills.trustedPrivateOrigins for trusted private hosting.${configurationInvalid ? ' The user configuration contains errors; check global.yml with ok config validate.' : ''}`,
    );
    this.name = 'SkillDestinationPolicyError';
    this.origin = canonicalOrigin;
  }
}

export class SkillSubpathNotFoundError extends SkillFetchError {}
