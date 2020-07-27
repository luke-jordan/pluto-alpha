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
    accountOpenDays: {
        type: 'match',
        description: 'Account opened X days ago',
        expects: 'number',
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
        description: 'Offered boost, not redeemed',
        expects: 'entity',
        table: 'boostTable',
        skipClient: true,
        entity: 'boost'
    },
    boostCount: {
        type: 'match', // see below for reasons (we use a subquery to deal with non-existence, though if used again becomes an anti-pattern)
        description: 'Number offered boosts',
        expects: 'number',
        table: 'transactionTable' // see below for need to select non-existent in boost table etc.
    },
    boostOffered: {
        type: 'aggregate', // because we allow inversions, we classify as aggregate, though it is actually match
        description: 'Part of boost (all from offer onwards)',
        expects: 'entity',
        entity: 'boost',
        table: 'boostTable',
        skipClient: true,
        canInvert: true
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

module.exports.convertBoostAllButCreated = (condition) => {
    // since exclusion happens at level of persisted intermediate audience, here we actually flip it to positive
    const boostIdOp = condition.op === 'exclude' ? 'is' : condition.op;
    return {
        conditions: [{ op: 'and', children: [
            { prop: 'boost_id', op: boostIdOp, value: condition.value },
            { prop: 'boost_status', op: 'not', value: 'CREATED' }
        ]}
    ]};
};

// bit of a monster because we need to pick up the non-existent in the boost table (i.e., count = 0), if this is less than
// hence we, this once, use a subquery directly in a primary convertor, but if needed again, instead implement a flag for
// inverted combinations, i.e., this is an aggregate and then do a not-in on intermediate audience
module.exports.convertBoostNumber = (condition) => {
    const startTime = condition.startTime ? moment(condition.startTime) : moment(0);
    const endTime = condition.endTime ? moment(condition.endTime) : moment();

    // note on status: at present we do not count status CREATED because that might pick up accounts not-yet-offered but
    // part of an ML-determined or event-driven boost that has not triggered for them yet
    
    const { op: passedOp } = condition;
    // eslint-disable-next-line no-nested-ternary
    const invertedOp = passedOp === 'is' ? '!=' : (passedOp === 'greater_than' ? '<=' : '>=');
    const subQuery = `select account_id from ${config.get('tables.boostTable')} where boost_status != 'CREATED' and ` + 
        `creation_time between '${startTime.format()}' and '${endTime.format()}' group by account_id ` +
        `having count(boost_id) ${invertedOp} ${parseInt(condition.value, 10)}`;

    const conditions = [{ op: 'not_in', prop: 'account_id', value: subQuery }];

    return { conditions };
};

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
// //////////////////////////////////// ACCOUNT & TIME CONDITIONS //////////////////////////////////////////////////////////
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

module.exports.convertCreationDaysToTime = (condition) => {
    const currentMoment = moment(); // avoid weirdness over midnight (sometimes refreshes etc happen then)
    // const clonedCondition = JSON.parse(JSON.stringify(condition)); // need to avoid mutability issues, hence deep clone not spread
    
    const convertedValue = currentMoment.subtract(condition.value, 'days').startOf('day').valueOf();
    let convertedOp = condition.op; 
    
    if (condition.op === 'less_than' || condition.op === 'less_than_or_equal_to') {
        convertedOp = 'greater_than_or_equal_to'; // because "less than 5 days" = "after 5 days ago"
    } else if (condition.op === 'greater_than' || condition.op === 'greater_than_or_equal_to') {
        convertedOp = 'less_than_or_equal_to';
    }
    
    return { value: convertedValue, op: convertedOp, prop: condition.prop };
};
