#! /bin/bash

# awslocal cloudformation create-stack --template-body file://cloudformation/dynamodb-table.yml --stack-name sample-table

export PGPASSWORD=alpineskiing
export PGUSER=master
export PGHOST=localhost
export PGPORT=5430
export PGDATABASE=pluto

echo "Setting up users"
psql -f ../templates/rds/create_db_roles.sql

echo "Setting up account ledger in RDS local"
psql -f ../templates/rds/create_account_ledger.sql

echo "Setting up transaction ledger in RDS local"
psql -f ../templates/rds/create_transaction_ledger.sql

echo "Setting up float ledger in RDS local"
psql -f ../templates/rds/create_float_ledger.sql
