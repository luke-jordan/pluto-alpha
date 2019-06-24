resource "aws_cloudwatch_log_metric_filter" "metric_filter" {
  log_group_name = "${var.log_group_name}"
  metric_transformation {
    name = "${var.metric_filter_name != "" ? var.metric_filter_name : var.alarm_name}"
    namespace = "${var.metric_namespace}"
    value = "1"
  }
  name = "${var.metric_filter_name != "" ? var.metric_filter_name : var.alarm_name}"
  pattern = "${var.pattern}"
}

resource "aws_cloudwatch_metric_alarm" "metric_alarm" {
  alarm_name = "${var.alarm_name}"
  comparison_operator = "${var.comparison_operator}"
  evaluation_periods = "${var.evaluation_periods}"
  metric_name = "${aws_cloudwatch_log_metric_filter.metric_filter.name}"
  namespace = "${var.metric_namespace}"
  period = "${var.period}"
  threshold = "${var.threshold}"
  statistic = "${var.statistic}"
  alarm_actions = ["${var.alarm_action_arn}"]
}

variable "log_group_name" {
  type = "string"
  description = "The name of the log group to associate the metric filter with"
}

variable "metric_namespace" {
  type = "string"
  description = "The destination namespace of the CloudWatch metric"
}

variable "pattern" {
  type = "string"
  description = "A valid CloudWatch Logs filter pattern for extracting metric data out of ingested log events"
}

variable "alarm_name" {
  type = "string"
  description = "The descriptive name for the alarm. This name must be unique within the user's AWS account"
}

variable "metric_filter_name" {
  type = "string"
  description = "A name for the metric filter"
  default = ""
}

variable "alarm_action_arn" {
  type = "string"
}

variable "comparison_operator" {
  type = "string"
  description = "The arithmetic operation to use when comparing the specified Statistic and Threshold. The specified Statistic value is used as the first operand. Either of the following is supported: GreaterThanOrEqualToThreshold, GreaterThanThreshold, LessThanThreshold, LessThanOrEqualToThreshold"
  default = "GreaterThanThreshold"
}

variable "evaluation_periods" {
  type = "string"
  description = "The number of periods over which data is compared to the specified threshold"
  default = "1"
}

variable "period" {
  type = "string"
  description = "The period in seconds over which the specified statistic is applied"
  default = "60"
}

variable "threshold" {
  type = "string"
  description = "The value against which the specified statistic is compared"
  default = "0"
}

variable "statistic" {
  type = "string"
  description = "The statistic to apply to the alarm's associated metric. Either of the following is supported: SampleCount, Average, Sum, Minimum, Maximum"
  default = "Sum"
}