#! /bin/bash

# If not running, bring it up and wipe it, but for now, fine
PGPASSWORD=alpineskiing psql -h localhost -p 5430 -U master -d pluto -f ./templates/persistence/clean_slate.sql
echo "Finished wiping DB, moving along"

docker-compose stop

sudo rm -rf /tmp/localstack/data/*
