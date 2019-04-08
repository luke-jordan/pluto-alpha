#! /bin/bash

# awslocal cloudformation create-stack --template-body file://cloudformation/dynamodb-table.yml --stack-name sample-table

export PGPASSWORD=alpineskiing
export PGUSER=master
export PGHOST=localhost
export PGPORT=5430
export PGDATABASE=avalanche

echo "Setting up users"
psql -f ./persistence/create_db_roles.sql

echo "Setting up account ledger in RDS local"
psql -f ./persistence/create_account_ledger.sql

echo "Setting up transaction ledger in RDS local"
psql -f ./persistence/create_transaction_ledger.sql
