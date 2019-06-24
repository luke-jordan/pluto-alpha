resource "aws_api_gateway_rest_api" "api-gateway" {
  name        = "${var.lambda_function_name}-${terraform.workspace}-rest-api"
}

resource "aws_api_gateway_deployment" "api-deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  stage_name  = "${terraform.workspace}-stage"

  depends_on = [aws_api_gateway_integration.float-api]
}


/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.proxy.id}"
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "{proxy+}"
}

resource "aws_lambda_permission" "allow_lambda_invocation" {
  action        = "lambda:InvokeFunction"
  function_name = "${var.lambda_function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "float-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.proxy.resource_id}"
  http_method = "${aws_api_gateway_method.proxy.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float-api-lambda.invoke_arn}"
}

/////////////// OTHER LAMBDA //////////////////////////////////////////////////////////////////////////