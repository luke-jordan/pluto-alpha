'use strict';

const logger = require('debug')('jupiter:audience:converter');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

// frontend has a complex nesteed structure that makes it very complex to insert the unit specification, hence this
const DEFAULT_FRONTEND_UNIT = 'WHOLE_CURRENCY';

module.exports.stdProperties = {
    saveCount: {
        type: 'aggregate',
        description: 'Number of saves',
        expects: 'number'
    },
    currentBalance: {
        type: 'aggregate',
        description: 'Sum of account balance',
        expects: 'amount',
        unit: DEFAULT_FRONTEND_UNIT
    },
    savedThisMonth: {
        type: 'aggregate',
        description: 'Saved this month',
        expects: 'amount',
        unit: DEFAULT_FRONTEND_UNIT
    },
    lastSaveTime: {
        type: 'aggregate', // since we select on max(creation_time)
        description: 'Last save date',
        expects: 'epochMillis'
    },
    accountOpenTime: {
        type: 'match',
        description: 'Account open date',
        expects: 'epochMillis',
        table: 'accountTable'
    },
    lastCapitalization: {
        type: 'match',
        description: 'Last capitalization',
        expects: 'epochMillis'
    },
    humanReference: {
        type: 'match',
        description: 'Human reference',
        expects: 'stringMultiple',
        table: 'accountTable'
    },
    pendingCount: {
        type: 'aggregate',
        description: 'Number of pending',
        expects: 'number'
    },
    anySaveCount: {
        type: 'aggregate',
        description: 'Number of (any) status save',
        expects: 'number'
    },
    numberFriends: {
        type: 'match',
        description: 'Number of saving friends',
        expects: 'number',
        table: 'accountTable' // since we use a subquery on match (pattern to be avoided, but else JSON structure far too complex, given user-id/account-id differences)
    },
    boostNotRedeemed: {
        type: 'match',
        description: 'Has not redeemed boost',
        expects: 'entity',
        table: 'boostTable',
        skipClient: true,
        entity: 'boost'
    },
    systemWideUserId: {
        type: 'match',
        description: 'System user ID (system only)',
        expects: 'stringMultiple',
        table: 'accountTable',
        excludeOnPanel: true
    }
};

module.exports.convertEpochToFormat = (epochMilli) => moment(parseInt(epochMilli, 10)).format();

const convertTxCountToColumns = (condition, txStatus) => {
    const columnConditions = [
        { prop: 'transaction_type', op: 'is', value: 'USER_SAVING_EVENT' }
    ];

    if (txStatus) {
        columnConditions.push({ prop: 'settlement_status', op: 'is', value: txStatus });
    }

    if (Number.isInteger(condition.startTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'greater_than', value: moment(condition.startTime).format() });
    }

    if (Number.isInteger(condition.endTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'less_than', value: moment(condition.endTime).format() });
    }

    return {
        conditions: [{ op: 'and', children: columnConditions }],
        groupBy: ['account_id'],
        postConditions: [
            { op: condition.op, prop: 'count(transaction_id)', value: condition.value, valueType: 'int' }
        ]
    };
};

module.exports.convertSaveCountToColumns = (condition) => convertTxCountToColumns(condition, 'SETTLED');

module.exports.convertPendingCountToColumns = (condition) => convertTxCountToColumns(condition, 'PENDING');

module.exports.convertAnySaveCountToColumns = (condition) => convertTxCountToColumns(condition);

// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////// SUMMATION SECTION (BALANCES, AMOUNTS) //////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const convertAmountToDefaultUnitQuery = `SUM(
    CASE
        WHEN unit = 'WHOLE_CENT' THEN
            amount * 100
        WHEN unit = 'WHOLE_CURRENCY' THEN
            amount * 10000
    ELSE
        amount
    END
    )`.replace(/\s\s+/g, ' '); // replace just neatens it up and makes consistent in tests etc

module.exports.convertSumBalanceToColumns = (condition) => {
    const settlementStatusToInclude = ['SETTLED', 'ACCRUED'];
    const transactionTypesToInclude = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'];

    const columnConditions = [
        { prop: 'settlement_status', op: 'in', value: settlementStatusToInclude },
        { prop: 'transaction_type', op: 'in', value: transactionTypesToInclude }
    ];

    if (Number.isInteger(condition.startTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'greater_than', value: moment(condition.startTime).format() });
    }

    if (Number.isInteger(condition.endTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'less_than', value: moment(condition.endTime).format() });
    }

    const fromUnit = condition.unit || DEFAULT_FRONTEND_UNIT;
    logger(`Transforming ${parseInt(condition.value, 10)} from ${fromUnit} to hundredth cent ...`);
    const amountInHundredthCent = opsUtil.convertToUnit(parseInt(condition.value, 10), fromUnit, 'HUNDREDTH_CENT');

    return {
        conditions: [{ op: 'and', children: columnConditions }],
        groupBy: ['account_id'],
        postConditions: [
            { op: condition.op, prop: convertAmountToDefaultUnitQuery, value: amountInHundredthCent, valueType: 'int' }
        ]
    };
};

module.exports.convertSavedThisMonth = (condition) => {
    const txInclusionConditions = [
        { prop: 'settlement_status', op: 'in', value: ['SETTLED'] }, // may add in future so might as well make in
        { prop: 'transaction_type', op: 'in', value: ['USER_SAVING_EVENT'] },
        { prop: 'creation_time', op: 'greater_than', value: moment().startOf('month').format() }
    ];

    const fromUnit = condition.unit || DEFAULT_FRONTEND_UNIT;
    const amountInHundredthCent = opsUtil.convertToUnit(parseInt(condition.value, 10), fromUnit, 'HUNDREDTH_CENT');

    return {
        conditions: [{ op: 'and', children: txInclusionConditions }],
        groupBy: ['account_id'],
        postConditions: [
            { op: condition.op, prop: convertAmountToDefaultUnitQuery, value: amountInHundredthCent, valueType: 'int' }
        ]
    };
};

// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////// BOOST, FRIEND SECTION  /////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

module.exports.convertBoostCreatedOffered = (condition) => ({
    conditions: [{ op: 'and', children: [
        { prop: 'boost_id', op: condition.op, value: condition.value },
        { prop: 'boost_status', op: 'in', value: ['CREATED', 'OFFERED', 'UNLOCKED'] }
    ]}]
});

module.exports.convertNumberFriends = (condition) => {
    const countSubQuery = `(select count(*) from ${config.get('tables.friendTable')} where (initiated_user_id = owner_user_id or accepted_user_id = owner_user_id) and ` +
        `relationship_status = 'ACTIVE')`;

    return {
        conditions: [
            { op: condition.op, prop: countSubQuery, value: condition.value, valueType: 'int' }
        ]
    };
};

// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////// UTILITY / AUX CONDITIONS ///////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

module.exports.humanRefInValueConversion = (value) => (Array.isArray(value) 
    ? value.map((item) => item.trim().toUpperCase()) 
    : value.split(', ').map((item) => item.trim().toUpperCase()));


// necessary because date-time 'is' does not mean 'is', it actually means 'in the interval of that day' 
module.exports.convertDateCondition = (condition, propToUse) => {
    const value = parseInt(condition.value, 10);

    if (condition.op !== 'is') {
        return { op: condition.op, prop: propToUse, value: moment(value).format() };
    }

    return { op: 'and', children: [
        { op: 'greater_than_or_equal_to', prop: propToUse, value: moment(value).startOf('day').format() },
        { op: 'less_than_or_equal_to', prop: propToUse, value: moment(value).endOf('day').format() }
    ]};
};
