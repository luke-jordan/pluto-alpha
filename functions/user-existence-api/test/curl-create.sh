#! /bin/bash

curl --header "Content-Type: application/json" --request POST   --data '{"ownerUserId": "2c957aca-47f9-4b4d-857f-a3205bfc6a78", "userFirstName": "Luke", "userFamilyName": "Jordan"}' http://localhost:4567/restapis/799A-Z979159/local/_user_request_/create

# docker run --net="unnamed_default" --rm -v "$PWD":/var/task lambci/lambda:nodejs10.x handler.create '{"ownerUserId": "2c957aca-47f9-4b4d-857f-a3205bfc6a78"}' --network bridge