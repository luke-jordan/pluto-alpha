'use strict';

module.exports.testValidClientId = 'zar_client_co';
module.exports.testValidFloatId = 'zar_cash_primary';
module.exports.testValidAccrualId = 'cash_backing_trans_id';

module.exports.testValueAccrualSize = 1000 * 10000; // ie R1,000
module.exports.testValueBonusPoolShare = (1 / 7.25); // in bps of accrual amount
module.exports.testValueClientShare = (0.25 / 7.25);

module.exports.testValueBonusPoolTracker = 'zar_cash_bonus_pool';
module.exports.testValueClientCompanyTracker = 'pluto_za_share';

module.exports.testValueBonus = {
    share: exports.testValueBonusPoolShare,
    tracker: exports.testValueBonusPoolTracker
};

module.exports.testValueClientCo = {
    share: exports.testValueClientCompanyShare,
    tracker: exports.testValueClientCompanyTracker
};

module.exports.allocationExpectedColumns = '${transaction_id}, ${client_id}, ${float_id}, ${t_type}, ${currency}, ${unit}, ${amount}, ' + 
    '${allocated_to_type}, ${allocated_to_id}, ${related_entity_type}, ${related_entity_id}';

module.exports.allocationExpectedQuery = (tableName) => `insert into ${tableName} ` +
    `(transaction_id, client_id, float_id, t_type, currency, unit, amount, ` +
    `allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) ` +
    `values %L returning transaction_id`;
