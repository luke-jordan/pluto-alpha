resource "aws_cloudwatch_event_rule" "ops_every_minute" {
    name = "ops_frequent_call"
    description = "Fires every one minute for frequent ops tasks (e.g., messages)"
    schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_rule" "ops_every_five_minutes" {
    name = "ops_regular_call"
    description = "Fires every five minutes for ops tasks"
    schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_rule" "ops_every_day" {
    name = "ops_daily_call"
    description = "Fires once a day for admin ops tasks"
    schedule_expression = "cron(0 22 * * ? *)"
}
