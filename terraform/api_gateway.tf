// On each new function : add to aws_api_gateway_deployment's depends_on related component

resource "aws_api_gateway_rest_api" "api_gateway" {
  name        = "${terraform.workspace}_rest_api"
  
}

resource "aws_api_gateway_deployment" "api_deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [
  aws_api_gateway_integration.float_api,
  aws_api_gateway_integration.user_activity_api,
  aws_api_gateway_integration.account_create,
  aws_api_gateway_integration.balance_fetch
  ]

  variables = {
    commit_sha1 = "${var.deploy_code_commit_hash}"
  }

  lifecycle {
    create_before_destroy = true
  }
}

/////////////////////// API GW LOGGING ///////////////////////////////////////////////////////////////
resource "aws_api_gateway_account" "api_gateway" {
  cloudwatch_role_arn = "${aws_iam_role.api_gateway_cloudwatch.arn}"

  depends_on = [aws_iam_role.api_gateway_cloudwatch]
}

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "api_gateway_cloudwatch_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "",
      "Effect": "Allow",
      "Principal": {
        "Service": "apigateway.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "api_gateway_cloudwatch" {
  name = "default"
  role = "${aws_iam_role.api_gateway_cloudwatch.id}"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
                "logs:GetLogEvents",
                "logs:FilterLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
EOF
}

resource "aws_api_gateway_method_settings" "general_settings" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.api_deployment.stage_name}"
  method_path = "*/*"

  settings {
    # Enable CloudWatch logging and metrics
    metrics_enabled        = true
    data_trace_enabled     = true
    logging_level          = "INFO"

    # Limit the rate of calls to prevent abuse and unwanted charges
    throttling_rate_limit  = 100
    throttling_burst_limit = 50
  }
}

/////////////////////// API GW DOMAIN ////////////////////////////////////////////////////////////////

resource "aws_api_gateway_domain_name" "custom_doname_name" {
  certificate_arn = "arn:aws:acm:us-east-1:455943420663:certificate/6fb77289-8ee8-420a-8f5b-6d62782e091e"
  domain_name     = "${terraform.workspace}.jupiterapp.net"
}

resource "aws_route53_record" "route" {
  name    = "${aws_api_gateway_domain_name.custom_doname_name.domain_name}"
  type    = "A"
  zone_id = "Z32F5PRK3A4ONK"

  alias {
    evaluate_target_health = true
    name                   = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_domain_name}"
    zone_id                = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_zone_id}"
  }
}

resource "aws_api_gateway_base_path_mapping" "custom_resourse_mapping" {
  api_id      = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.api_deployment.stage_name}"
  domain_name = "${aws_api_gateway_domain_name.custom_doname_name.domain_name}"
}


/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "float_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.float_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "float_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "float-api"
}

resource "aws_lambda_permission" "float_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "float_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.float_api.resource_id}"
  http_method = "${aws_api_gateway_method.float_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float_api.invoke_arn}"
}

/////////////// USER ACTIVITY API LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_activity_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user_activity_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "user-activity-api"
}

resource "aws_lambda_permission" "user_activity_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user_activity_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.user_activity_api.resource_id}"
  http_method = "${aws_api_gateway_method.user_activity_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user_activity_api.invoke_arn}"
}

/////////////// ACCOUNT CREATE API LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "account_create" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.account_create.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "account_create" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "account-create"
}

resource "aws_lambda_permission" "account_create" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.account_create.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "account_create" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.account_create.resource_id}"
  http_method = "${aws_api_gateway_method.account_create.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.account_create.invoke_arn}"
}

/////////////// ACCOUNT BALANCE LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "balance_fetch" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.balance_fetch.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "balance_fetch" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "balance_fetch"
}

resource "aws_lambda_permission" "balance_fetch" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.balance_fetch.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "balance_fetch" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.balance_fetch.resource_id}"
  http_method = "${aws_api_gateway_method.balance_fetch.http_method}"

  integration_http_method = "GET"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.balance_fetch.invoke_arn}"
}
