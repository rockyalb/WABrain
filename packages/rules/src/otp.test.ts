import { describe, expect, it } from "vitest";
import { isOneTimeCode } from "./otp.js";

describe("isOneTimeCode", () => {
  it.each([
    "Your verification code is 482913. Do not share it with anyone.",
    "Verification code: 482913",
    "your code is 5521",
    "Code: 7731",
    "PIN 4410",
    "Never share this code: 118 204",
    "Your WhatsApp code: 123-456. Don't share this code with others",
    "G-582341 is your Google verification code.",
    "Use 739201 to verify your account.",
    "Your OTP is 00912. It expires in 5 minutes.",
    "Your login code is 441932",
    "882211 is your security code",
    "Do not share this code with anyone: 6612",
    "Verification: 9021",
    "Security code 443322",
  ])("detects %s", (text) => {
    expect(isOneTimeCode(text)).toBe(true);
  });

  it.each([
    "send me the contract tomorrow",
    "The postal code for the office is 1001",
    "The meeting is at 1400 on Friday, room 2034",
    "Send me invoice 12345 tmrw pls",
    "Invoice no 20240915 must be paid by Friday",
    "the code review is at 1500 tomorrow",
    "The code on github has over 12000 lines, we need to review it this week because there is a lot to fix and test before we launch the new version of the app",
    "Phone 0691234567, call me when you can",
    "The new card's PIN arrives by post",
    "Use promo code 2024 for 20% off",
    "Pay 450 EUR for the rent by 5 October",
    "I sent 1500 EUR yesterday, can you check?",
    "",
  ])("keeps %s", (text) => {
    expect(isOneTimeCode(text)).toBe(false);
  });

  it("uses the sender as a hint for bank messages", () => {
    const text = "Transaction 9912 approved, valid for 3 minutes, use this code in the app. Thank you for using our online banking services every day.";
    expect(isOneTimeCode(text)).toBe(false);
    expect(isOneTimeCode(text, { senderName: "Example Bank" })).toBe(true);
    expect(isOneTimeCode(text, { senderName: "Ana" })).toBe(false);
  });

  it("does not treat a bank message without a code as a one-time code", () => {
    expect(isOneTimeCode("Your account was credited", { senderName: "Raiffeisen Bank" })).toBe(false);
  });
});
