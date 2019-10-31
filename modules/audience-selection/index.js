'use strict';

class AudienceSelection {

    playingWithRecursion(unit) {
        // base case
        if (unit.op === 'is') {
            if (unit.type === 'int') {
                return `${unit.prop}=${unit.value}`;
            }
            return `${unit.prop}='${unit.value}'`;
        }

        if (unit.op === 'and' && unit.children) {
            return '(' + unit.children.map(innerUnit => this.playingWithRecursion(innerUnit)).join(' and ') + ')';
        }

        if (unit.op === 'or' && unit.children) {
            return '(' + unit.children.map(innerUnit => this.playingWithRecursion(innerUnit)).join(' or ') + ')';
        }
    }


    fetchUsersGivenJSON (selectionJSON) {
        const queryBeginning = `select * from ${selectionJSON.table} where `;

        const answer = selectionJSON.conditions.map((block) => this.playingWithRecursion(block)).join('');

        console.log('raw answer', answer);
        console.log('full answer', queryBeginning + answer);
        return queryBeginning + answer;
    }

    fetchUsersGivenJSON_v2 (selectionJSON) {
        const queryBeginning = `select * from ${selectionJSON.table} where `;
        const answer = selectionJSON.conditions.map((block) => {
            if (block.op === 'and' && block.children) {
                return block.children.map((innerBlock) => {
                    if (innerBlock.op === 'is') {
                        return `${innerBlock.prop}='${innerBlock.value}'`;
                    }
                }).join(' and ');
            }

            if (block.op === 'or' && block.children) {
                return block.children.map((innerBlock) => {
                    if (innerBlock.op === 'is') {
                        return `${innerBlock.prop}='${innerBlock.value}'`;
                    }

                    if (innerBlock.op === 'and' && innerBlock.children) {
                        return innerBlock.children.map(inner_innerBlock => {
                            if (inner_innerBlock.op === 'is') {
                                return `${inner_innerBlock.prop}='${inner_innerBlock.value}'`;
                            }
                        }).join(' and ');
                    }
                }).join(' or ');
            }
        });

        console.log('answer', answer);
        console.log('full answer', queryBeginning + answer);
        return queryBeginning + answer;
    }


    fetchUsersGivenJSON_v1 (selectionJSON) {
        const queryBeginning = `select * from ${selectionJSON.table} where `;
        const answer = selectionJSON.conditions.map((block) => {
           if (block.op === 'and' && block.children) {
               return block.children.map((innerBlock) => {
                   if (innerBlock.op === 'is') {
                       return `${innerBlock.prop}='${innerBlock.value}'`;
                   }
               }).join(' and ');
           }

            if (block.op === 'or' && block.children) {
                return block.children.map((innerBlock) => {
                    if (innerBlock.op === 'is') {
                        return `${innerBlock.prop}='${innerBlock.value}'`;
                    }
                }).join(' or ');
            }
        });

        console.log('answer', answer);
        console.log('full answer', queryBeginning + answer);
        return queryBeginning + answer;
    }
}

module.exports = new AudienceSelection();
