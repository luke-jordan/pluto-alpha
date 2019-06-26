// On each new function : add to aws_api_gateway_deployment's depends_on related component


resource "aws_api_gateway_rest_api" "api-gateway" {
  name        = "${terraform.workspace}-rest-api"
}

resource "aws_api_gateway_deployment" "api-deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [aws_api_gateway_integration.float-api, aws_api_gateway_integration.user-activity-api]
}



/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "float-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.float-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

// example curl -X POST https://iaxlt9v3x1.execute-api.us-east-1.amazonaws.com/staging-stage/float-api
resource "aws_api_gateway_resource" "float-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "float-api"
}

resource "aws_lambda_permission" "float-api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "float-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.float-api.resource_id}"
  http_method = "${aws_api_gateway_method.float-api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float-api.invoke_arn}"
}

/////////////// USER ACT LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user-activity-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user-activity-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

// example curl -X POST https://iaxlt9v3x1.execute-api.us-east-1.amazonaws.com/staging-stage/user-activity-api
resource "aws_api_gateway_resource" "user-activity-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "user-activity-api"
}

resource "aws_lambda_permission" "user-activity-api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user-activity-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "user-activity-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.user-activity-api.resource_id}"
  http_method = "${aws_api_gateway_method.user-activity-api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user-activity-api.invoke_arn}"
}

/////////////// AUTH API LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user-insertion-handler" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user-insertion-handler.id}"
  http_method   = "POST"
  authorization = "NONE"
}

// example curl -X POST https://iaxlt9v3x1.execute-api.us-east-1.amazonaws.com/staging-stage/user-insertion-handler
resource "aws_api_gateway_resource" "user-insertion-handler" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "create-new-user"
}

resource "aws_lambda_permission" "user-insertion-handler" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user-insertion-handler.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "user-insertion-handler" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.user-insertion-handler.resource_id}"
  http_method = "${aws_api_gateway_method.user-insertion-handler.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user-insertion-handler.invoke_arn}"
}