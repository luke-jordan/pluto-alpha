'use strict';

module.exports.floatUnits = {
    HUNDREDTH_CENT: 'HUNDREDTH_CENT',
    WHOLE_CENT: 'WHOLE_CENT',
    DEFAULT: 'HUNDREDTH_CENT'
};

// NOTE: these are expressed in multiples of the DEFAULT unit
module.exports.floatUnitTransforms = {
    DEFAULT: 1,
    HUNDREDTH_CENT: 1,
    WHOLE_CENT: 100
};

module.exports.floatTransTypes = {
    ACCRUAL: 'ACCRUAL',
    ALLOCATION: 'ALLOCATION',
    DEPOSIT: 'DEPOSIT',
    WITHDRAWAL: 'WITHDRAWAL',
    CAPITALIZATION: 'CAPITALIZATION'
};

module.exports.entityTypes = {
    ACCRUAL_EVENT: 'ACCRUAL_EVENT', // so that we can track and audit these
    BONUS_POOL: 'BONUS_POOL',
    COMPANY_SHARE: 'COMPANY_SHARE',
    END_USER_ACCOUNT: 'END_USER_ACCOUNT',
    FLOAT_ITSELF: 'FLOAT_ITSELF'
};

module.exports.EXCESSS_KEY = 'excess';

Object.freeze(exports.floatUnits);
Object.freeze(exports.floatTransTypes);
Object.freeze(exports.entityTypes);