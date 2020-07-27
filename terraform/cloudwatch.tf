resource "aws_cloudwatch_event_rule" "ops_every_minute" {
    name = "ops_frequent_call"
    description = "Fires every one minute for frequent ops tasks (e.g., messages)"
    schedule_expression = "rate(2 minutes)"
}

resource "aws_cloudwatch_event_rule" "ops_every_five_minutes" {
    name = "ops_regular_call"
    description = "Fires every five minutes for ops tasks"
    schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_rule" "ops_every_day" {
    name = "ops_daily_call_night"
    description = "Fires once a day for admin ops tasks"
    schedule_expression = "cron(0 22 * * ? *)"
}

resource "aws_cloudwatch_event_rule" "ops_admin_daytime" {
    name = "ops_admin_daytime_call"
    description = "Fires during the day for pending tx scan"
    schedule_expression = "cron(0 6-18/2 * * ? *)"
}

# This is for dynamic and ML boosts which run at ~10am
resource "aws_cloudwatch_event_rule" "daily_boost_triggers" {
    name = "ops_boost_daily"
    description = "Fires once a day in the morning, to do dynamic-ML-etc boost offers"
    schedule_expression = "cron(0 8 * * ? *)"
}
