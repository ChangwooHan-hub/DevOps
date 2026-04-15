import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class SignatureVerifierService {
  verify(rawBody: Buffer | undefined, signatureHeader: string | undefined, secret: string) {
    if (!rawBody || !signatureHeader) {
      throw new UnauthorizedException('missing webhook signature');
    }

    const expectedSignature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const expectedBuffer = Buffer.from(expectedSignature);
    const actualBuffer = Buffer.from(signatureHeader);

    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new UnauthorizedException('invalid webhook signature');
    }
  }
}

