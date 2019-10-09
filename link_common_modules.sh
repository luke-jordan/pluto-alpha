#! /bin/bash

cd ./modules/rds-common && npm install && sudo npm link && cd ../dynamo-common && npm install && sudo npm link