import { simpleflake } from 'simpleflakes';

export function logErrorWithCode(log, e) {
    const errorCode = simpleflake().toJSON();
    log.error({...e, errorCode: errorCode}, `ErrorCode: ${errorCode})`);
    return errorCode;
}
