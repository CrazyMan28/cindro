// Unit test for PhonePolicyStore — the phone-scoped capability policy.
// Hermetic: uses the explicit `root` ctor arg (a QTemporaryDir) for isolation,
// which works on every platform (unlike qputenv("HOME") which QDir::homePath()
// ignores on Windows in favor of USERPROFILE).

#include "jarvis/PhonePolicyStore.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

using jarvis::PhonePolicyStore;

int main()
{
    QTemporaryDir root;
    if (!root.isValid()) {
        std::fprintf(stderr, "FAIL: could not create temp root\n");
        return 1;
    }

    // --- 1) Fresh store => every capability at its catalogued default ----------
    {
        PhonePolicyStore p(root.path());
        check(p.value(QStringLiteral("answer_calls")) == QStringLiteral("screen_unknown"),
              "default: answer_calls=screen_unknown");
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("ask"),
              "default: send_sms=ask");
        check(p.value(QStringLiteral("outbound_calls")) == QStringLiteral("allow"),
              "default: outbound_calls=allow");
        check(p.value(QStringLiteral("spend_money")) == QStringLiteral("ask"),
              "default: spend_money=ask");
        check(p.value(QStringLiteral("access_memory")) == QStringLiteral("allow"),
              "default: access_memory=allow");
        check(p.value(QStringLiteral("computer_use_on_call")) == QStringLiteral("deny"),
              "default: computer_use_on_call=deny");
        check(p.value(QStringLiteral("access_files")) == QStringLiteral("ask"),
              "default: access_files=ask");
        check(PhonePolicyStore::catalog().size() == 7, "catalog has 7 capabilities");
    }

    // --- 2) setValue validation ----------------------------------------------
    {
        PhonePolicyStore p(root.path());
        check(p.setValue(QStringLiteral("send_sms"), QStringLiteral("deny")),
              "setValue(send_sms, deny) accepted");
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("deny"),
              "send_sms now deny");
        check(!p.setValue(QStringLiteral("send_sms"), QStringLiteral("bogus")),
              "setValue rejects a value outside the choice list");
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("deny"),
              "rejected set left the prior value intact");
        check(!p.setValue(QStringLiteral("nonexistent_cap"), QStringLiteral("allow")),
              "setValue rejects an unknown capability");
        check(p.setValue(QStringLiteral("answer_calls"), QStringLiteral("allowed_only")),
              "setValue(answer_calls, allowed_only) accepted");
        check(!p.setValue(QStringLiteral("answer_calls"), QStringLiteral("deny")),
              "answer_calls rejects a tri-state value it doesn't offer");
    }

    // --- 3) Persistence across a reload --------------------------------------
    {
        PhonePolicyStore p(root.path());
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("deny"),
              "reload: send_sms=deny persisted");
        check(p.value(QStringLiteral("answer_calls")) == QStringLiteral("allowed_only"),
              "reload: answer_calls=allowed_only persisted");
    }

    // --- 4) decisionForTool mapping ------------------------------------------
    {
        // Fresh defaults (send_sms=ask, spend_money=ask, outbound_calls=allow,
        // access_memory=allow) on a SEPARATE root so section 2/3 edits don't leak.
        QTemporaryDir root2;
        PhonePolicyStore p(root2.path());
        check(p.decisionForTool(QStringLiteral("device_sms")) == QStringLiteral("ask"),
              "device_sms -> send_sms(ask)");
        check(p.decisionForTool(QStringLiteral("twilio_sms")) == QStringLiteral("ask"),
              "twilio_sms -> stricter(send_sms ask, spend_money ask) = ask");
        check(p.decisionForTool(QStringLiteral("call_user")) == QStringLiteral("allow"),
              "call_user -> outbound_calls(allow)");
        check(p.decisionForTool(QStringLiteral("twilio_call_and_wait")) == QStringLiteral("ask"),
              "twilio_call_and_wait -> stricter(outbound_calls allow, spend_money ask) = ask");
        check(p.decisionForTool(QStringLiteral("store_memory")) == QStringLiteral("allow"),
              "store_memory -> access_memory(allow)");
        check(p.decisionForTool(QStringLiteral("some_unmapped_tool")) == QStringLiteral("allow"),
              "an ungated tool -> allow");

        // spend_money is the STRICTER-of gate: deny it and a billed tool denies
        // even though its per-action capability is allow.
        check(p.setValue(QStringLiteral("spend_money"), QStringLiteral("deny")),
              "set spend_money=deny");
        check(p.decisionForTool(QStringLiteral("twilio_call_and_wait")) == QStringLiteral("deny"),
              "twilio_call_and_wait -> deny (spend_money stricter)");
        check(p.decisionForTool(QStringLiteral("call_user")) == QStringLiteral("allow"),
              "in-app call_user unaffected by spend_money (no PSTN cost)");
        check(p.decisionForTool(QStringLiteral("device_sms")) == QStringLiteral("ask"),
              "device_sms unaffected by spend_money (free SIM)");
    }

    // --- 5) reset restores defaults ------------------------------------------
    {
        PhonePolicyStore p(root.path());
        // root still has the section-2 edits persisted
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("deny"),
              "pre-reset: send_sms still deny");
        check(p.reset(), "reset() succeeds");
        check(p.value(QStringLiteral("send_sms")) == QStringLiteral("ask"),
              "post-reset: send_sms back to default ask");
        check(p.value(QStringLiteral("answer_calls")) == QStringLiteral("screen_unknown"),
              "post-reset: answer_calls back to default screen_unknown");
        PhonePolicyStore p2(root.path());
        check(p2.value(QStringLiteral("send_sms")) == QStringLiteral("ask"),
              "reset persisted across reload");
    }

    // --- 6) isGatedTool -------------------------------------------------------
    {
        check(PhonePolicyStore::isGatedTool(QStringLiteral("twilio_sms")),
              "twilio_sms is a gated tool");
        check(!PhonePolicyStore::isGatedTool(QStringLiteral("list_extensions")),
              "list_extensions is not gated");
        check(PhonePolicyStore::capabilitiesForTool(QStringLiteral("twilio_call_and_wait"))
                  .contains(QStringLiteral("spend_money")),
              "twilio_call_and_wait maps to spend_money too");
    }

    // --- 7) toJson shape ------------------------------------------------------
    {
        PhonePolicyStore p(root.path());
        const QJsonObject j = p.toJson();
        check(j.value(QStringLiteral("version")).toInt() == 1, "toJson version=1");
        const QJsonArray caps = j.value(QStringLiteral("capabilities")).toArray();
        check(caps.size() == 7, "toJson has 7 capabilities");
        bool sawSendSms = false;
        for (const QJsonValue &v : caps) {
            const QJsonObject o = v.toObject();
            if (o.value(QStringLiteral("id")).toString() == QStringLiteral("send_sms")) {
                sawSendSms = true;
                check(o.contains(QStringLiteral("label")), "send_sms entry has a label");
                check(o.value(QStringLiteral("enforcement")).toString() == QStringLiteral("hard"),
                      "send_sms enforcement=hard");
                check(o.value(QStringLiteral("choices")).toArray().size() == 3,
                      "send_sms has 3 choices");
            }
            if (o.value(QStringLiteral("id")).toString() == QStringLiteral("computer_use_on_call"))
                check(o.value(QStringLiteral("enforcement")).toString() == QStringLiteral("soft"),
                      "computer_use_on_call enforcement=soft (guidance)");
        }
        check(sawSendSms, "toJson includes the send_sms capability");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS phone_policy_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL phone_policy_test (%d failures)\n", g_failures);
    return 1;
}
